// Органайзер — дневен cron: генерира задачи за автоматично
// повтарящите се задължения (SPEC.md §4, §6).
//
// Идемпотентно — всеки ден "осигурява" съществуването на задачата за
// текущия приложим период; уникалният индекс
// (client_id, obligation_type_id, period_label) в схемата пази от
// дублиране при повторно/забавено изпълнение (unique_violation,
// код 23505, се третира като "вече съществува", не като грешка).
//
// НЕ генерира задачи от тип "по събитие" (chl55 дивидент/наем,
// чл.88 ЗКПО, майчинство, болничен) — тях ги отваря ръчно
// служител/admin, когато настъпи събитието.
// НЕ генерира "before_activity_start" (напр. ЕСТИ регистрация) —
// тя е еднократна, създава се при добавяне на дейността в UI, не тук.
//
// Всички дати се смятат в Europe/Sofia, не UTC (SPEC.md §7) —
// самият тригер (cron schedule) може да гръмне по UTC час, но
// "кой ден е днес" винаги се определя през Sofia календара по-долу.

import { createClient } from "npm:@supabase/supabase-js@2";

const SOFIA_TZ = "Europe/Sofia";

// ---------------------------------------------------------------
// Дата помощни функции
// ---------------------------------------------------------------

export function sofiaToday(): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SOFIA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

export function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

export function toISODate(y: number, m: number, d: number): string {
  return `${y.toString().padStart(4, "0")}-${pad(m)}-${pad(d)}`;
}

export function weekday(y: number, m: number, d: number): number {
  // 0=неделя..6=събота; смята се през UTC, за да няма дрейф от TZ.
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addMonths(y: number, m: number, months: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + months;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

/** true = позволено е да генерираме задача с този срок за клиента —
 * т.е. срокът НЕ е преди `tasksStartDate` (clients.tasks_start_date,
 * по подразбиране = датата на добавяне в Органайзер). Решава случая
 * "нова фирма получава фантомна задача за стар срок, който реално не
 * дължи" (напр. ГДД чл.92 ЗКПО за 2025 г., генерирана за фирма,
 * регистрирана през 2026 — 41 дни назад, под 60-дневния grace праг
 * по-долу, но фирмата не е съществувала през облагаемата година).
 * null/undefined tasksStartDate = няма ограничение (за съвместимост,
 * не би трябвало да се случва — колоната е NOT NULL). */
export function dueDateAllowed(dueDate: string, tasksStartDate: string | null | undefined): boolean {
  if (!tasksStartDate) return true;
  return dueDate >= tasksStartDate;
}

/** Брой дни от `fromISO` до `toISO` (положително = to е по-късно). */
export function daysBetween(fromISO: string, toISO: string): number {
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  return Math.round((toMs - fromMs) / 86400000);
}

/** чл. 22, ал. 7 ДОПК: пренася до следващия работен ден, ако пада в
 * събота, неделя или официален празник (виж таблица `holidays`). */
export function shiftToBusinessDay(iso: string, holidaySet: Set<string>): string {
  let [y, m, d] = iso.split("-").map(Number);
  for (let guard = 0; guard < 30; guard++) {
    const wd = weekday(y, m, d);
    const isoNow = toISODate(y, m, d);
    if (wd !== 0 && wd !== 6 && !holidaySet.has(isoNow)) return isoNow;
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    y = next.getUTCFullYear();
    m = next.getUTCMonth() + 1;
    d = next.getUTCDate();
  }
  throw new Error(`shiftToBusinessDay: не намерих работен ден от ${iso}`);
}

// ---------------------------------------------------------------
// deadline_rule → период(и), за които днес трябва да съществува
// задача. Виж 0001_init.sql за пълната конвенция на deadline_rule.
// ---------------------------------------------------------------

type Period = {
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  dueDateRaw: string; // преди пренасяне при почивен ден
};

export function periodsForRule(
  rule: { type: string; day?: number; month?: number; year_offset?: number },
  today: { y: number; m: number; d: number },
): Period[] {
  switch (rule.type) {
    case "day_of_next_month": {
      // Период = предходния календарен месец спрямо днес; срокът е
      // rule.day-о число на месеца СЛЕД периода.
      const { y, m } = addMonths(today.y, today.m, -1);
      const due = addMonths(y, m, 1);
      const day = Math.min(rule.day!, lastDayOfMonth(due.y, due.m));
      return [{
        periodLabel: `${y}-${pad(m)}`,
        periodStart: toISODate(y, m, 1),
        periodEnd: toISODate(y, m, lastDayOfMonth(y, m)),
        dueDateRaw: toISODate(due.y, due.m, day),
      }];
    }
    case "fixed_date": {
      // Срокът винаги пада в текущата година (y) — датата, на която се
      // подава. Периодът, който се ОТЧИТА, може да е различна година:
      // year_offset (-1 по подразбиране 0 = текущата) — повечето
      // годишни декларации (ГДД, ГФО...) отчитат ПРЕДХОДНАТА година и
      // носят year_offset: -1 в каталога (виж 0065 миграцията), само
      // няколко (патентна декларация, местни данъци, чл.87а...) наистина
      // засягат текущата и оставят полето празно/0.
      const y = today.y;
      const dueDateRaw = toISODate(y, rule.month!, rule.day!);
      // Не backfill-ваме годишно задължение, чийто срок вече е далеч
      // отминал, при ПЪРВОТО му генериране (напр. нов клиент, добавен
      // през август — да не получи фантомна "просрочена от март"
      // задача веднага). Прагът е грубо "разумен прозорец за
      // наваксване", не точна законова граница — открито на живо,
      // искане повторено изрично след два подобни случая.
      if (daysBetween(dueDateRaw, toISODate(today.y, today.m, today.d)) > 60) return [];
      const py = y + (rule.year_offset ?? 0);
      return [{
        periodLabel: `${py}`,
        periodStart: toISODate(py, 1, 1),
        periodEnd: toISODate(py, 12, 31),
        dueDateRaw,
      }];
    }
    case "monthly_advance_zkpo_schedule": {
      // яну–мар → 15 апр; апр–ное → 15-о текущия месец; дек → 1 дек
      const y = today.y, m = today.m;
      let dueDateRaw: string;
      if (m >= 1 && m <= 3) dueDateRaw = toISODate(y, 4, 15);
      else if (m >= 4 && m <= 11) dueDateRaw = toISODate(y, m, 15);
      else dueDateRaw = toISODate(y, 12, 1);
      return [{
        periodLabel: `${y}-${pad(m)}`,
        periodStart: toISODate(y, m, 1),
        periodEnd: toISODate(y, m, lastDayOfMonth(y, m)),
        dueDateRaw,
      }];
    }
    case "quarterly_advance_zkpo_schedule": {
      // Q1,Q2 → 15-о на месеца след тримесечието; Q3 → 1 дек; Q4 → няма
      const y = today.y, m = today.m;
      const q = Math.ceil(m / 3);
      if (q === 4) return [];
      const dueDateRaw = q === 1
        ? toISODate(y, 4, 15)
        : q === 2
        ? toISODate(y, 7, 15)
        : toISODate(y, 12, 1); // Q3
      return [{
        periodLabel: `${y}-Q${q}`,
        periodStart: toISODate(y, (q - 1) * 3 + 1, 1),
        periodEnd: toISODate(y, q * 3, lastDayOfMonth(y, q * 3)),
        dueDateRaw,
      }];
    }
    default:
      // quarter_end_plus (event), before_activity_start (еднократно
      // при добавяне на дейност), manual (chl.88, майчинство) —
      // съзнателно НЕ се генерират тук.
      return [];
  }
}

// ---------------------------------------------------------------
// Главна функция
// ---------------------------------------------------------------

const JOB_NAME = "daily_task_generation";

// import.meta.main е true само когато Deno изпълнява ТОЗИ файл пряко
// (production) — не и когато тестов файл го импортира само за да
// ползва export-натите чисти функции по-горе.
if (import.meta.main) {
  Deno.serve(handler);
}

// CORS — досега функцията се викаше само от крона (сървър-до-сървър,
// няма нужда от CORS), но сега index.html я вика и директно от
// браузъра веднага след създаване на клиент, за да не се чака до
// 24ч следващия крон (виж коментар в index.html при GENERATE_TASKS_URL).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const today = sofiaToday();

    // Опционален client_id в тялото — за целенасочен извик веднага
    // след създаване на НОВ клиент (виж index.html), за да не се
    // пипат/възкресяват изтрити задачи на ВСИЧКИ останали клиенти.
    // Дневният крон продължава без него (обработва всички, както досега).
    let onlyClientId: string | null = null;
    try {
      const body = await req.json();
      onlyClientId = body?.client_id ?? null;
    } catch (_e) {
      // няма тяло (напр. крон извик без body) — обработва всички, наред е
    }

    const { data: holidaysData, error: holidaysErr } = await supabase
      .from("holidays")
      .select("holiday_date");
    if (holidaysErr) throw holidaysErr;
    const holidaySet = new Set((holidaysData ?? []).map((h: { holiday_date: string }) => h.holiday_date));

    // Всички включени задължения по клиент — филтрираме активни
    // клиенти и текущата версия на всяко задължение в JS (не през
    // embedded-filter синтаксис в PostgREST, за да е по-предвидимо).
    let query = supabase
      .from("client_obligation_settings")
      .select(`
        enabled, client_id,
        clients ( id, active, responsible_user_id, tasks_start_date, office_pays_obligations ),
        obligation_types ( id, deadline_rule, valid_to, requires_payment )
      `)
      .eq("enabled", true);
    if (onlyClientId) query = query.eq("client_id", onlyClientId);
    const { data: rows, error: rowsErr } = await query;
    if (rowsErr) throw rowsErr;

    const activeRows = (rows ?? []).filter((r: any) =>
      r.clients?.active === true && r.obligation_types?.valid_to === null
    );

    let created = 0;
    let alreadyExisted = 0;
    const errors: string[] = [];

    for (const row of activeRows as any[]) {
      const client = row.clients;
      const obligation = row.obligation_types;
      const periods = periodsForRule(obligation.deadline_rule, today);

      for (const p of periods) {
        const dueDate = shiftToBusinessDay(p.dueDateRaw, holidaySet);
        if (!dueDateAllowed(dueDate, client.tasks_start_date)) continue;

        const { data: insertedTask, error: insertErr } = await supabase
          .from("tasks")
          .insert({
            client_id: client.id,
            obligation_type_id: obligation.id,
            period_label: p.periodLabel,
            period_start: p.periodStart,
            period_end: p.periodEnd,
            assigned_user_id: client.responsible_user_id,
            due_date: dueDate,
            status: "waiting",
          })
          .select("id")
          .single();

        if (insertErr) {
          if ((insertErr as any).code === "23505") {
            // unique_violation — задачата за този период вече
            // съществува. Очаквано и наред, не е грешка.
            alreadyExisted++;
          } else {
            errors.push(`${client.id}/${obligation.id}/${p.periodLabel}: ${insertErr.message}`);
          }
        } else {
          created++;

          // Ако задължението поражда плащане, създаваме и записа за
          // него още сега — сумата (amount_due) остава null, докато
          // някой я въведе ръчно или я извлечем от потвърждението
          // (recognize-confirmation, засега само за ГДД оборота, не
          // за самата дължима сума). Срокът за плащане по подразбиране
          // = срокът за подаване, освен ако конкретното задължение не
          // казва друго (в каталога засега винаги съвпадат — SPEC.md §6).
          // office_pays_obligations (0064, поискано 2026-08-26) — само
          // за клиентите, за които офисът реално превежда парите вместо
          // тях; за другите не се създава запис за плащане изобщо.
          if (obligation.requires_payment && client.office_pays_obligations && insertedTask) {
            const { error: paymentErr } = await supabase.from("task_payments").insert({
              task_id: insertedTask.id,
              due_date: dueDate,
              paid: false,
            });
            if (paymentErr) errors.push(`payment for ${insertedTask.id}: ${paymentErr.message}`);
          }
        }
      }
    }

    await supabase.from("cron_heartbeats").insert({
      job_name: JOB_NAME,
      status: errors.length === 0 ? "ok" : "error",
      details: `created=${created} already_existed=${alreadyExisted} errors=${errors.length}` +
        (errors.length ? ` :: ${errors.slice(0, 5).join(" | ")}` : ""),
    });

    return new Response(
      JSON.stringify({ ok: errors.length === 0, created, alreadyExisted, errors }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    // Дори при неочаквана грешка записваме heartbeat със статус
    // 'error' — за разлика от ЛИПСВАЩ heartbeat (крона изобщо не се
    // е задействал), това показва опит, който е паднал. Външният
    // monitor (SPEC.md §5) следи и двата случая по различен начин.
    try {
      await supabase.from("cron_heartbeats").insert({
        job_name: JOB_NAME,
        status: "error",
        details: String(e),
      });
    } catch (_ignored) {
      // ако дори heartbeat записът падне — тишината на монитора е сигналът
    }
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
