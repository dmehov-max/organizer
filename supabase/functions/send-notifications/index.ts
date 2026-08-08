// Органайзер — дневен cron: имейл известия и ескалации (SPEC.md §5).
//
// Логика:
//  - напомняне 5 РАБОТНИ дни преди срока, ако задачата не е "completed"
//  - напомняне 1 РАБОТЕН ден преди срока
//  - спешно писмо в деня на срока
//  - незабавна тревога при отказ/грешка в потвърждение (веднъж на задача)
//  - ЕДИН дневен дайджест до admin-ите с всичко просрочено (задачи +
//    плащания) — НЕ писмо по всяка просрочена задача поотделно
//  - напомняния за плащане (T-5/T-1 работни дни), аналогично на задачите
//
// Идемпотентно през notification_log — всеки тип известие се
// проверява преди изпращане (SPEC.md §5, review бележка за dedupe).
//
// Изисква secrets (Edge Functions → Secrets):
//   RESEND_API_KEY  — ключ от resend.com
//   RESEND_FROM     — изпращащ адрес, напр. "Органайзер <organizer@korekt-bg.com>"
//                      (трябва да е от верифициран в Resend домейн)

import { createClient } from "npm:@supabase/supabase-js@2";

const SOFIA_TZ = "Europe/Sofia";

// ---------------------------------------------------------------
// Дата помощни функции (нарочно дублирани от generate-tasks — виж
// бележката в README защо не споделяме модул между функциите)
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
function parseISO(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}
function weekday(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function isBusinessDay(y: number, m: number, d: number, holidays: Set<string>): boolean {
  const wd = weekday(y, m, d);
  return wd !== 0 && wd !== 6 && !holidays.has(toISODate(y, m, d));
}

/** Брой работни дни от `fromISO` до `toISO` (изключва fromISO,
 * включва toISO), 0 ако съвпадат. Отрицателно, ако toISO е в миналото. */
function businessDaysBetween(fromISO: string, toISO: string, holidays: Set<string>): number {
  if (fromISO === toISO) return 0;
  const from = parseISO(fromISO);
  const sign = toISO > fromISO ? 1 : -1;
  let { y, m, d } = from;
  let count = 0;
  for (let guard = 0; guard < 3000; guard++) {
    const next = new Date(Date.UTC(y, m - 1, d + sign));
    y = next.getUTCFullYear();
    m = next.getUTCMonth() + 1;
    d = next.getUTCDate();
    const iso = toISODate(y, m, d);
    if (isBusinessDay(y, m, d, holidays)) count += sign;
    if (iso === toISO) return count;
  }
  throw new Error(`businessDaysBetween: не стигнах до ${toISO} от ${fromISO}`);
}

// ---------------------------------------------------------------
// Email
// ---------------------------------------------------------------

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "Органайзер <onboarding@resend.dev>";

async function sendEmail(to: string[], subject: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (to.length === 0) return { ok: true };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: RESEND_FROM, to, subject, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Resend ${res.status}: ${body}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---------------------------------------------------------------
// Главна функция
// ---------------------------------------------------------------

const JOB_NAME = "daily_notifications";

Deno.serve(async (_req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const sendErrors: string[] = [];
  let sentCount = 0;

  try {
    const today = sofiaToday();
    const todayISO = toISODate(today.y, today.m, today.d);

    const { data: holidaysData } = await supabase.from("holidays").select("holiday_date");
    const holidays = new Set((holidaysData ?? []).map((h: { holiday_date: string }) => h.holiday_date));

    // Имейли по потребител (profiles не пази имейл, вижте SPEC.md §3)
    const { data: usersList, error: usersErr } = await supabase.auth.admin.listUsers({ perPage: 200 });
    if (usersErr) throw usersErr;
    const emailById = new Map<string, string>();
    for (const u of usersList.users) if (u.email) emailById.set(u.id, u.email);

    const { data: profiles, error: profilesErr } = await supabase
      .from("profiles")
      .select("id, role, active");
    if (profilesErr) throw profilesErr;
    const adminEmails = (profiles ?? [])
      .filter((p: any) => p.role === "admin" && p.active)
      .map((p: any) => emailById.get(p.id))
      .filter((e): e is string => !!e);

    // Помощна: изпрати, ако все още не е логнато днешно известие от този тип
    async function notifyOnce(
      opts: {
        taskId?: string | null;
        paymentId?: string | null;
        type: string;
        to: string[];
        subject: string;
        text: string;
        dedupeByDate?: boolean; // false = веднъж изобщо, не по дата (за rejection_alert)
      },
    ) {
      let existsQuery = supabase
        .from("notification_log")
        .select("id", { count: "exact", head: true })
        .eq("notification_type", opts.type);
      if (opts.taskId) existsQuery = existsQuery.eq("task_id", opts.taskId);
      else existsQuery = existsQuery.is("task_id", null);
      if (opts.paymentId) existsQuery = existsQuery.eq("payment_id", opts.paymentId);
      if (opts.dedupeByDate !== false) existsQuery = existsQuery.eq("notification_date", todayISO);

      const { count, error: checkErr } = await existsQuery;
      if (checkErr) {
        sendErrors.push(`dedupe-check ${opts.type}: ${checkErr.message}`);
        return;
      }
      if (count && count > 0) return; // вече изпратено

      const result = await sendEmail(opts.to, opts.subject, opts.text);
      sentCount += result.ok ? 1 : 0;
      if (!result.ok) sendErrors.push(`${opts.type}/${opts.taskId ?? "digest"}: ${result.error}`);

      await supabase.from("notification_log").insert({
        task_id: opts.taskId ?? null,
        payment_id: opts.paymentId ?? null,
        notification_type: opts.type,
        notification_date: todayISO,
        sent_to: null, // multi-recipient известия не пазим единичен получател тук
        status: result.ok ? "sent" : "failed",
        error: result.ok ? null : result.error,
      });
    }

    // ------------------------------------------------------------
    // 1. Задачи, които не са завършени
    // ------------------------------------------------------------
    const { data: tasks, error: tasksErr } = await supabase
      .from("tasks")
      .select(`
        id, due_date, status, confirmation_status, assigned_user_id,
        clients ( name ),
        obligation_types ( name )
      `)
      .neq("status", "completed")
      .eq("not_applicable", false);
    if (tasksErr) throw tasksErr;

    const overdueForDigest: string[] = [];

    for (const t of (tasks ?? []) as any[]) {
      const assigneeEmail = t.assigned_user_id ? emailById.get(t.assigned_user_id) : undefined;
      const clientName = t.clients?.name ?? "?";
      const obligationName = t.obligation_types?.name ?? "?";
      const bdays = businessDaysBetween(todayISO, t.due_date, holidays);

      if (assigneeEmail) {
        if (bdays === 5) {
          await notifyOnce({
            taskId: t.id, type: "reminder_t5", to: [assigneeEmail],
            subject: `Наближава срок (5 раб. дни): ${obligationName} — ${clientName}`,
            text: `Срокът за "${obligationName}" на ${clientName} е ${t.due_date} (след 5 работни дни).`,
          });
        } else if (bdays === 1) {
          await notifyOnce({
            taskId: t.id, type: "reminder_t1", to: [assigneeEmail],
            subject: `Утре е срокът: ${obligationName} — ${clientName}`,
            text: `Срокът за "${obligationName}" на ${clientName} е утре, ${t.due_date}.`,
          });
        } else if (t.due_date === todayISO) {
          await notifyOnce({
            taskId: t.id, type: "due_today", to: [assigneeEmail],
            subject: `⚠ Днес е срокът: ${obligationName} — ${clientName}`,
            text: `Днес (${t.due_date}) изтича срокът за "${obligationName}" на ${clientName}. Действие незабавно.`,
          });
        }
      }

      if (t.due_date < todayISO) {
        overdueForDigest.push(`- ${clientName} — ${obligationName} (срок беше ${t.due_date})`);
      }

      // Незабавна тревога при отказано потвърждение — веднъж на задача
      if (t.confirmation_status === "rejected") {
        const toList = [...(assigneeEmail ? [assigneeEmail] : []), ...adminEmails];
        await notifyOnce({
          taskId: t.id, type: "rejection_alert", dedupeByDate: false, to: toList,
          subject: `🚫 Отказано потвърждение: ${obligationName} — ${clientName}`,
          text: `Прикаченото потвърждение за "${obligationName}" на ${clientName} е разпознато като отказано/с грешка. Провери в системата.`,
        });
      }
    }

    // ------------------------------------------------------------
    // 2. Плащания — напомняния + просрочени за дайджеста
    // ------------------------------------------------------------
    const { data: payments, error: paymentsErr } = await supabase
      .from("task_payments")
      .select(`
        id, due_date, paid,
        tasks ( id, assigned_user_id, clients ( name ), obligation_types ( name ) )
      `)
      .eq("paid", false);
    if (paymentsErr) throw paymentsErr;

    for (const p of (payments ?? []) as any[]) {
      const task = p.tasks;
      const assigneeEmail = task?.assigned_user_id ? emailById.get(task.assigned_user_id) : undefined;
      const clientName = task?.clients?.name ?? "?";
      const obligationName = task?.obligation_types?.name ?? "?";
      const bdays = businessDaysBetween(todayISO, p.due_date, holidays);

      if (assigneeEmail) {
        if (bdays === 5) {
          await notifyOnce({
            paymentId: p.id, taskId: task?.id, type: "payment_reminder", to: [assigneeEmail],
            subject: `Наближава срок за плащане (5 раб. дни): ${clientName}`,
            text: `Плащането за "${obligationName}" на ${clientName} е дължимо до ${p.due_date}.`,
          });
        } else if (bdays === 1) {
          await notifyOnce({
            paymentId: p.id, taskId: task?.id, type: "payment_reminder", to: [assigneeEmail],
            subject: `Утре е срокът за плащане: ${clientName}`,
            text: `Плащането за "${obligationName}" на ${clientName} е дължимо утре, ${p.due_date}.`,
          });
        }
      }

      if (p.due_date < todayISO) {
        overdueForDigest.push(`- [ПЛАЩАНЕ] ${clientName} — ${obligationName} (срок беше ${p.due_date})`);
      }
    }

    // ------------------------------------------------------------
    // 3. Дневен дайджест до admin-ите (само ако има просрочено)
    // ------------------------------------------------------------
    if (overdueForDigest.length > 0 && adminEmails.length > 0) {
      await notifyOnce({
        type: "escalation_digest",
        to: adminEmails,
        subject: `Органайзер — ${overdueForDigest.length} просрочени към ${todayISO}`,
        text: `Просрочени задачи/плащания:\n\n${overdueForDigest.join("\n")}`,
      });
    }

    await supabase.from("cron_heartbeats").insert({
      job_name: JOB_NAME,
      status: sendErrors.length === 0 ? "ok" : "error",
      details: `sent=${sentCount} errors=${sendErrors.length}` +
        (sendErrors.length ? ` :: ${sendErrors.slice(0, 5).join(" | ")}` : ""),
    });

    return new Response(
      JSON.stringify({ ok: sendErrors.length === 0, sent: sentCount, errors: sendErrors }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    try {
      await supabase.from("cron_heartbeats").insert({ job_name: JOB_NAME, status: "error", details: String(e) });
    } catch (_ignored) { /* тишината на монитора е сигналът */ }
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
