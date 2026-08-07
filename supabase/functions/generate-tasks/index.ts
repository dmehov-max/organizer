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

function sofiaToday(): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SOFIA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function toISODate(y: number, m: number, d: number): string {
  return `${y.toString().padStart(4, "0")}-${pad(m)}-${pad(d)}`;
}

function weekday(y: number, m: number, d: number): number {
  // 0=неделя..6=събота; смята се през UTC, за да няма дрейф от TZ.
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addMonths(y: number, m: number, months: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + months;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

/** чл. 22, ал. 7 ДОПК: пренася до следващия работен ден, ако пада в
 * събота, неделя или официален празник (виж таблица `holidays`). */
function shiftToBusinessDay(iso: string, holidaySet: Set<string>): string {
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

function periodsForRule(
  rule: { type: string; day?: number; month?: number },
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
      // Период = текущата година; фиксирана календарна дата.
      const y = today.y;
      return [{
        periodLabel: `${y}`,
        periodStart: toISODate(y, 1, 1),
        periodEnd: toISODate(y, 12, 31),
        dueDateRaw: toISODate(y, rule.month!, rule.day!),
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

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const today = sofiaToday();

    const { data: holidaysData, error: holidaysErr } = await supabase
      .from("holidays")
      .select("holiday_date");
    if (holidaysErr) throw holidaysErr;
    const holidaySet = new Set((holidaysData ?? []).map((h: { holiday_date: string }) => h.holiday_date));

    // Всички включени задължения по клиент — филтрираме активни
    // клиенти и текущата версия на всяко задължение в JS (не през
    // embedded-filter синтаксис в PostgREST, за да е по-предвидимо).
    const { data: rows, error: rowsErr } = await supabase
      .from("client_obligation_settings")
      .select(`
        enabled,
        clients ( id, active, responsible_user_id ),
        obligation_types ( id, deadline_rule, valid_to )
      `)
      .eq("enabled", true);
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

        const { error: insertErr } = await supabase.from("tasks").insert({
          client_id: client.id,
          obligation_type_id: obligation.id,
          period_label: p.periodLabel,
          period_start: p.periodStart,
          period_end: p.periodEnd,
          assigned_user_id: client.responsible_user_id,
          due_date: dueDate,
          status: "waiting",
        });

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
      { headers: { "Content-Type": "application/json" } },
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
      headers: { "Content-Type": "application/json" },
    });
  }
});
