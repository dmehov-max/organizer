// Органайзер — дневен cron: имейл известия и ескалации (SPEC.md §5).
//
// Логика:
//  - ЕДИН сборен имейл на служител за наближаващи срокове (5 работни
//    дни преди), не писмо за всяка задача поотделно
//  - ЕДИН сборен имейл на служител за "утре е срокът" (1 работен ден)
//  - ЕДИН сборен имейл на служител за "днес изтича" — все още се
//    праща веднага (в същия дневен пуск), просто обединен ако са
//    няколко задачи наведнъж, не N отделни писма
//  - незабавна тревога при отказ/грешка в потвърждение — отделно,
//    веднъж на задача (критично, не се събира в дайджест)
//  - ЕДИН дневен дайджест до admin-ите с всичко просрочено (задачи +
//    плащания)
//  - плащанията (T-5/T-1) се вливат в СЪЩИТЕ сборни имейли на
//    служителя, не отделен канал
//
// "Пренасяне при почивен ден, ако последният ден от срока е почивен"
// (чл. 22, ал. 7 ДОПК) вече е приложено при СЪЗДАВАНЕТО на задачата
// (generate-tasks) — due_date, върху който тази функция брои работни
// дни, вече е коригиран, не се пипа тук пак.
//
// Идемпотентно през notification_log (SPEC.md §5, review бележка).
//
// Изисква secrets (Edge Functions → Secrets):
//   RESEND_API_KEY, RESEND_FROM

import { createClient } from "npm:@supabase/supabase-js@2";

const SOFIA_TZ = "Europe/Sofia";

// ---------------------------------------------------------------
// Дата помощни функции (нарочно дублирани от generate-tasks)
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
 * включва toISO); 0 при съвпадение, отрицателно ако toISO е в миналото. */
function businessDaysBetween(fromISO: string, toISO: string, holidays: Set<string>): number {
  if (fromISO === toISO) return 0;
  const sign = toISO > fromISO ? 1 : -1;
  let { y, m, d } = parseISO(fromISO);
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
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM, to, subject, text }),
    });
    if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${await res.text()}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---------------------------------------------------------------
// Сборни "кофи" по служител
// ---------------------------------------------------------------

type BundleItem = { line: string; taskId: string };
type Bundles = Record<string, { t5: BundleItem[]; t1: BundleItem[]; today: BundleItem[] }>;

function bucket(bundles: Bundles, userId: string) {
  if (!bundles[userId]) bundles[userId] = { t5: [], t1: [], today: [] };
  return bundles[userId];
}

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

    const { data: usersList, error: usersErr } = await supabase.auth.admin.listUsers({ perPage: 200 });
    if (usersErr) throw usersErr;
    const emailById = new Map<string, string>();
    for (const u of usersList.users) if (u.email) emailById.set(u.id, u.email);

    const { data: profiles, error: profilesErr } = await supabase.from("profiles").select("id, role, active");
    if (profilesErr) throw profilesErr;
    const adminEmails = (profiles ?? [])
      .filter((p: any) => p.role === "admin" && p.active)
      .map((p: any) => emailById.get(p.id))
      .filter((e): e is string => !!e);

    async function notifyOnce(opts: {
      taskId?: string | null;
      sentTo?: string | null; // за сборни известия на служител — дедупликира отделно на човек
      type: string;
      to: string[];
      subject: string;
      text: string;
      dedupeByDate?: boolean; // false = веднъж изобщо, не по дата (rejection_alert)
    }) {
      let q = supabase.from("notification_log").select("id", { count: "exact", head: true })
        .eq("notification_type", opts.type);
      q = opts.taskId ? q.eq("task_id", opts.taskId) : q.is("task_id", null);
      q = opts.sentTo ? q.eq("sent_to", opts.sentTo) : q.is("sent_to", null);
      if (opts.dedupeByDate !== false) q = q.eq("notification_date", todayISO);

      const { count, error: checkErr } = await q;
      if (checkErr) { sendErrors.push(`dedupe-check ${opts.type}: ${checkErr.message}`); return; }
      if (count && count > 0) return; // вече изпратено

      const result = await sendEmail(opts.to, opts.subject, opts.text);
      sentCount += result.ok ? 1 : 0;
      if (!result.ok) sendErrors.push(`${opts.type}/${opts.taskId ?? opts.sentTo ?? "digest"}: ${result.error}`);

      await supabase.from("notification_log").insert({
        task_id: opts.taskId ?? null,
        notification_type: opts.type,
        notification_date: todayISO,
        sent_to: opts.sentTo ?? null,
        status: result.ok ? "sent" : "failed",
        error: result.ok ? null : result.error,
      });
    }

    // ------------------------------------------------------------
    // Задачи — пълним "кофите" по служител + просроченото за дайджеста
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

    const bundles: Bundles = {};
    const overdueForDigest: string[] = [];

    for (const t of (tasks ?? []) as any[]) {
      const clientName = t.clients?.name ?? "?";
      const obligationName = t.obligation_types?.name ?? "?";
      const line = `- ${clientName} — ${obligationName} (срок: ${t.due_date})`;

      if (t.assigned_user_id) {
        const bdays = businessDaysBetween(todayISO, t.due_date, holidays);
        const b = bucket(bundles, t.assigned_user_id);
        if (bdays === 5) b.t5.push({ line, taskId: t.id });
        else if (bdays === 1) b.t1.push({ line, taskId: t.id });
        else if (t.due_date === todayISO) b.today.push({ line, taskId: t.id });
      }

      if (t.due_date < todayISO) overdueForDigest.push(`${line} [задача]`);

      if (t.confirmation_status === "rejected") {
        const assigneeEmail = t.assigned_user_id ? emailById.get(t.assigned_user_id) : undefined;
        const toList = [...(assigneeEmail ? [assigneeEmail] : []), ...adminEmails];
        await notifyOnce({
          taskId: t.id, type: "rejection_alert", dedupeByDate: false, to: toList,
          subject: `🚫 Отказано потвърждение: ${obligationName} — ${clientName}`,
          text: `Прикаченото потвърждение за "${obligationName}" на ${clientName} е разпознато като отказано/с грешка. Провери в системата.`,
        });
      }
    }

    // ------------------------------------------------------------
    // Плащания — вливат се в СЪЩИТЕ кофи по служител + просрочени
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
      const clientName = task?.clients?.name ?? "?";
      const obligationName = task?.obligation_types?.name ?? "?";
      const line = `- [ПЛАЩАНЕ] ${clientName} — ${obligationName} (срок: ${p.due_date})`;

      if (task?.assigned_user_id) {
        const bdays = businessDaysBetween(todayISO, p.due_date, holidays);
        const b = bucket(bundles, task.assigned_user_id);
        if (bdays === 5) b.t5.push({ line, taskId: p.id });
        else if (bdays === 1) b.t1.push({ line, taskId: p.id });
        else if (p.due_date === todayISO) b.today.push({ line, taskId: p.id });
      }

      if (p.due_date < todayISO) overdueForDigest.push(line);
    }

    // ------------------------------------------------------------
    // Изпращане на сборните имейли — един на служител на "кофа"
    // ------------------------------------------------------------
    for (const [userId, b] of Object.entries(bundles)) {
      const email = emailById.get(userId);
      if (!email) continue;

      if (b.t5.length > 0) {
        await notifyOnce({
          sentTo: userId, type: "reminder_t5", to: [email],
          subject: `Наближаващи срокове (5 раб. дни) — ${b.t5.length} бр.`,
          text: `Следните срокове наближават (5 работни дни):\n\n${b.t5.map((x) => x.line).join("\n")}`,
        });
      }
      if (b.t1.length > 0) {
        await notifyOnce({
          sentTo: userId, type: "reminder_t1", to: [email],
          subject: `Утре изтичат ${b.t1.length} срока`,
          text: `Следните срокове изтичат утре:\n\n${b.t1.map((x) => x.line).join("\n")}`,
        });
      }
      if (b.today.length > 0) {
        await notifyOnce({
          sentTo: userId, type: "due_today", to: [email],
          subject: `⚠ Днес изтичат ${b.today.length} срока — действие незабавно`,
          text: `Днес (${todayISO}) изтичат:\n\n${b.today.map((x) => x.line).join("\n")}`,
        });
      }
    }

    // ------------------------------------------------------------
    // Дневен дайджест до admin-ите (само ако има просрочено)
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

    return new Response(JSON.stringify({ ok: sendErrors.length === 0, sent: sentCount, errors: sendErrors }), {
      headers: { "Content-Type": "application/json" },
    });
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
