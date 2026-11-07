// Органайзер — месечно напомняне към всички активни клиенти да качат
// документите си в Controlisy (първоначално само за фирмите по ДДС,
// разширено на 2026-10-30, оттам и името). Виж README.md.
//
// ВЪЗСТАНОВЕН на 2026-11-06 от живата версия в Supabase (v8, на живо
// като "vat-documents-reminder") — кодът е бил деплойнат директно, без
// файл в репото. Съдържанието е точно деплойнатото.
//
// Вика се всеки ден от cron; пълната автоматика е изискване: никой
// не натиска нищо. Функцията сама решава дали днес е денят.
//
// Три писма за месец: първия работен ден до всички, на 7-о и на 10-о
// само до тези без отговор. API-то на Controlisy е само за качване и
// не казва кой какво е качил, затова източникът са отговорите в info@.
//
// Режимът е в automation_settings, не в код: 'test' праща до един
// адрес и най-много test_limit писма, 'live' — до клиентите.
// force важи само в 'test', за да не може ръчно да се пусне писмо до
// клиент извън графика.
//
// Подателят е фиксиран умишлено (решение от 2026-10-30): всичко към
// клиенти тръгва от info@. Праща се през SMTP на пощенския сървър на
// домейна, а не през Resend: той вече е в SPF и има DKIM, така че не
// са нужни DNS промени. Порт 465, защото Supabase блокира 25 и 587.
// При грешка писмото се записва като failed — не минава през друг адрес.
//
// Изисква secrets: SMTP_HOST, SMTP_USER, SMTP_PASSWORD

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";
import MailComposer from "npm:nodemailer@6.9.16/lib/mail-composer/index.js";
import { ImapFlow } from "npm:imapflow@1.0.171";
import { simpleParser } from "npm:mailparser@3.7.2";

const SOFIA_TZ = "Europe/Sofia";
const JOB_NAME = "vat_documents_reminder";
const KIND = "vat_documents";
const FROM = "МЕХОВ Консулт <info@mehovconsult.com>";
const REPLY_TO = "info@mehovconsult.com";
const DEADLINE_DAY = 5;
const SECOND_REMINDER_DAY = 7;
const THIRD_REMINDER_DAY = 10;
// Отговори се четат до това число; след него напомняния няма.
const LAST_SCAN_DAY = 15;
// Колко дни след датата още може да тръгне закъсняло писмо (например
// ако проверката на пощата е паднала в самия ден).
const CATCH_UP_DAYS = 2;
// Пауза между две писма до клиенти (07.11.2026): 35 писма в една
// секунда от един адрес изглеждат като спам за получаващите сървъри.
// 4 с × 35 = ~2,5 мин — спокойно в лимита на функцията.
export const SEND_PAUSE_MS = 4000;
// Четенето на отговорите по IMAP понякога зависва („няма отговор след
// 70 с“, 07.11.2026) — втори опит след кратка пауза, преди да се
// откажем за деня.
export const IMAP_ATTEMPTS = 2;
export const IMAP_RETRY_PAUSE_MS = 8000;
const CONFIRM_PAGE = "https://dmehov-max.github.io/organizer/confirm.html";

const MONTHS = [
  "януари", "февруари", "март", "април", "май", "юни",
  "юли", "август", "септември", "октомври", "ноември", "декември",
];

export function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isBusinessDay(d: Date, holidays: Set<string>): boolean {
  const wd = d.getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays.has(toISO(d));
}

function nextBusinessDay(y: number, m: number, day: number, holidays: Set<string>): Date {
  const d = new Date(Date.UTC(y, m - 1, day));
  while (!isBusinessDay(d, holidays)) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function previousBusinessDay(y: number, m: number, day: number, holidays: Set<string>): Date {
  const d = new Date(Date.UTC(y, m - 1, day));
  while (!isBusinessDay(d, holidays)) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

/** Напомнянето е на датата или в работния ден преди нея, но никога не
 * преди `after`: „срокът беше“ не може да тръгне в самия ден на срока. */
function reminderDay(y: number, m: number, day: number, after: Date, holidays: Set<string>): Date {
  const d = previousBusinessDay(y, m, day, holidays);
  if (d > after) return d;
  const next = new Date(after);
  do {
    next.setUTCDate(next.getUTCDate() + 1);
  } while (!isBusinessDay(next, holidays));
  return next;
}

/** Първото писмо тръгва в първия работен ден на месеца, за предходния
 * месец (решение от 2026-10-30). Срокът в него е 5-о, а ако е неработен —
 * първият работен ден след него (процес „Месечен цикъл“). Следващите
 * две са на 7-о и 10-о или работния ден преди тях. */
export function monthSchedule(y: number, m: number, holidays: Set<string>) {
  const period = new Date(Date.UTC(y, m - 2, 1));
  const deadline = nextBusinessDay(y, m, DEADLINE_DAY, holidays);
  const second = reminderDay(y, m, SECOND_REMINDER_DAY, deadline, holidays);
  const third = reminderDay(y, m, THIRD_REMINDER_DAY, second, holidays);
  return {
    sendISO: toISO(nextBusinessDay(y, m, 1, holidays)),
    deadlineISO: toISO(deadline),
    secondISO: toISO(second),
    thirdISO: toISO(third),
    periodLabel: toISO(period).slice(0, 7),
    periodName: `${MONTHS[period.getUTCMonth()]} ${period.getUTCFullYear()}`,
  };
}

function isWithinCatchUp(today: string, dayISO: string): boolean {
  const limit = new Date(`${dayISO}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + CATCH_UP_DAYS);
  return today >= dayISO && today <= toISO(limit);
}

/** Кое писмо е наред днес. Прозорецът е кратък умишлено: включване на
 * режим live в края на месеца не бива да изпрати стари напомняния. */
export function dueStage(
  today: string,
  s: { sendISO: string; secondISO: string; thirdISO: string },
): 1 | 2 | 3 | null {
  if (isWithinCatchUp(today, s.thirdISO)) return 3;
  if (isWithinCatchUp(today, s.secondISO)) return 2;
  if (isWithinCatchUp(today, s.sendISO)) return 1;
  return null;
}

export function kindForStage(stage: number): string {
  return stage === 1 ? KIND : `${KIND}_${stage}`;
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

/** Линкът е първият начин за потвърждение; отговорът с „Качено“ остава
 * за тези, които предпочитат да пишат. */
function confirmLines(confirmUrl: string): string[] {
  return [
    "Моля, потвърдете получаването на писмото от този линк:",
    confirmUrl,
    "",
    "Там можете да отбележите и че сте качили всичко или че нямате документи за месеца. Можете също да отговорите на това писмо с „Качено“ или „Нямам документи“.",
  ];
}

/** Фирмите без ДДС получават друг текст: при тях поводът не е
 * декларацията, а по-добрата отчетност (решение от 2026-10-30). */
export function buildEmail(clientName: string, periodName: string, deadlineISO: string, isVat: boolean, confirmUrl: string) {
  const deadline = `${formatDate(deadlineISO)} г.`;
  return {
    subject: `Документи за ${periodName} – ${clientName}`,
    text: [
      "Уважаеми клиенти,",
      "",
      isVat
        ? `Напомняме Ви да качите в Controlisy всички приходни и разходни документи на ${clientName} за ${periodName} г. най-късно до ${deadline}`
        : `С цел по-добра отчетност Ви молим да качите в Controlisy всички приходни и разходни документи на ${clientName} за ${periodName} г. най-късно до ${deadline} Така ще можем да ги обработим своевременно.`,
      "",
      "Това включва фактури за продажби и покупки, кредитни и дебитни известия, банкови извлечения и отчети от касов апарат, ако използвате такъв.",
      "",
      ...(isVat
        ? ["Моля, обърнете специално внимание на приходните документи. Пропусната приходна фактура не може да се включи в друг месец.", ""]
        : []),
      ...confirmLines(confirmUrl),
      "",
      "Благодарим Ви!",
      "",
      "С уважение,",
      "Екипът на МЕХОВ Консулт",
    ].join("\n"),
  };
}

export function buildFollowUp(clientName: string, periodName: string, deadlineISO: string, stage: number, isVat: boolean, confirmUrl: string) {
  const opening = stage === 2 ? "Напомняне" : "Второ напомняне";
  return {
    subject: `${opening}: документи за ${periodName} – ${clientName}`,
    text: [
      "Уважаеми клиенти,",
      "",
      `Към момента нямаме потвърждение, че документите на ${clientName} за ${periodName} г. са качени в Controlisy. Срокът беше ${formatDate(deadlineISO)} г.`,
      "",
      isVat
        ? "Моля, качете ги възможно най-скоро, за да подготвим ДДС декларацията навреме."
        : "Моля, качете ги възможно най-скоро, за да можем да ги обработим своевременно.",
      "",
      ...confirmLines(confirmUrl),
      "",
      "Благодарим Ви!",
      "",
      "С уважение,",
      "Екипът на МЕХОВ Консулт",
    ].join("\n"),
  };
}

/** Само новият текст на отговора, без цитираното писмо отдолу. */
export function stripQuoted(text: string): string {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*(On .* wrote:|На .*написа:|-{2,}\s*Original Message|-{2,}\s*Оригинално|From:|От:|Sent from|Изпратено от)/i.test(line)) break;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

/** Първо се търси „още не съм“: „ще кача утре“ съдържа „кача“, но
 * не значи готово. Съмнителното е 'question' и отива при човек. */
export function classifyReply(text: string): "done" | "question" {
  const t = stripQuoted(text).toLowerCase();
  if (/\?|не съм|още не|ще кач|не мога|не успя|утре|проблем|помощ/.test(t)) return "question";
  if (/качен|качих|качихме|качили|готово|нямам документи|нямаме документи|няма документи|без документи/.test(t)) return "done";
  return "question";
}

/** Към кой клиент е отговорът. Подателят трябва да е от адресите на
 * клиента, а името в темата решава при обща поща на няколко фирми. */
export function matchClient<T extends { name: string; contact_emails: string[] | null }>(
  fromAddress: string,
  subject: string,
  clients: T[],
  testRecipient: string | null,
): T | null {
  const from = fromAddress.toLowerCase();
  const candidates = from === testRecipient?.toLowerCase()
    ? clients
    : clients.filter((c) => (c.contact_emails ?? []).some((e) => e.toLowerCase() === from));
  const byName = candidates.filter((c) => subject.includes(c.name));
  if (byName.length === 1) return byName[0];
  return candidates.length === 1 && from !== testRecipient?.toLowerCase() ? candidates[0] : null;
}

function sofiaTodayISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SOFIA_TZ }).format(new Date());
}

function mailer() {
  return nodemailer.createTransport({
    host: Deno.env.get("SMTP_HOST")!,
    port: 465,
    secure: true,
    auth: { user: Deno.env.get("SMTP_USER")!, pass: Deno.env.get("SMTP_PASSWORD")! },
  });
}

function imapClient() {
  return new ImapFlow({
    host: Deno.env.get("SMTP_HOST")!,
    port: 993,
    secure: true,
    auth: { user: Deno.env.get("SMTP_USER")!, pass: Deno.env.get("SMTP_PASSWORD")! },
    logger: false,
    // Бързо отказване (07.11.2026): по подразбиране ImapFlow чака ~70 с
    // на зависнала връзка; два опита + копието в „Изпратени“ надхвърляха
    // лимита на шлюза (504) и писмата изобщо не тръгваха.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
  });
}

/** SMTP не пази копие, затова всяко писмо се записва и в „Изпратени“
 * на info@ (поискано изрично 2026-10-30), за да стои в кутията. */
async function openSentFolder() {
  const client = imapClient();
  await client.connect();
  const folders = await client.list();
  const sent = folders.find((f: { specialUse?: string }) => f.specialUse === "\\Sent") ??
    folders.find((f: { path: string }) => /(^|[./])(sent|sent items|изпратени)$/i.test(f.path));
  if (!sent) {
    await client.logout();
    throw new Error("Няма папка за изпратени писма");
  }
  return { client, path: sent.path as string };
}

type SentFolder = Awaited<ReturnType<typeof openSentFolder>>;

/** Връща грешка при изпращане или null. Копието е отделно: неуспешно
 * копие не значи неизпратено писмо, затова идва в copyErrors. */
async function sendEmail(
  to: string[],
  subject: string,
  text: string,
  sentFolder: SentFolder | null,
  copyErrors: string[],
): Promise<string | null> {
  let raw: Uint8Array;
  try {
    raw = await new MailComposer({ from: FROM, replyTo: REPLY_TO, to, subject, text }).compile().build();
    await mailer().sendMail({ envelope: { from: REPLY_TO, to }, raw });
  } catch (e) {
    return String(e);
  }
  if (sentFolder) {
    try {
      await sentFolder.client.append(sentFolder.path, raw, ["\\Seen"]);
    } catch (e) {
      copyErrors.push(`${subject}: ${String(e)}`);
    }
  }
  return null;
}

export function buildReport(
  today: string,
  stage: number | null,
  periodName: string,
  results: { name: string; error: string | null }[],
  errors: string[],
  copyErrors: string[],
) {
  const sent = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);
  const hasProblem = failed.length > 0 || errors.length > 0 || copyErrors.length > 0;
  const lines = [
    `Дата: ${formatDate(today)}`,
    `Писмо: ${stage ?? "няма"} от 3, документи за ${periodName}`,
    `Изпратени: ${sent.length} от ${results.length}`,
    "",
  ];
  if (failed.length > 0) lines.push("НЕИЗПРАТЕНИ:", ...failed.map((r) => `- ${r.name}: ${r.error}`), "");
  if (errors.length > 0) lines.push("ГРЕШКИ:", ...errors.map((e) => `- ${e}`), "");
  if (copyErrors.length > 0) lines.push("БЕЗ КОПИЕ В ИЗПРАТЕНИ:", ...copyErrors.map((e) => `- ${e}`), "");
  if (sent.length > 0) lines.push("Изпратени до:", ...sent.map((r) => `- ${r.name}`));
  return {
    subject: `${hasProblem ? "ПРОБЛЕМ: " : ""}Напомняния за документи – изпратени ${sent.length} от ${results.length}`,
    text: lines.join("\n"),
  };
}

type Reply = {
  messageId: string;
  from: string;
  subject: string;
  date: Date | null;
  text: string;
};

/** Отговорите за месеца в info@. Кутията е отворена само за четене,
 * за да не се маркират писмата като прочетени. Съдържанието се сваля
 * само за писмата с нашата тема, а автоматичните отговори се прескачат. */
async function readReplies(sinceISO: string, periodName: string): Promise<Reply[]> {
  const client = imapClient();
  const replies: Reply[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const uids = await client.search({ since: new Date(`${sinceISO}T00:00:00Z`) }, { uid: true });
      const matching: { uid: number; messageId: string; from: string; subject: string; date: Date | null }[] = [];
      if (uids && uids.length > 0) {
        for await (const m of client.fetch(uids, { envelope: true, uid: true }, { uid: true })) {
          const subject = m.envelope?.subject ?? "";
          const from = m.envelope?.from?.[0]?.address ?? "";
          if (!subject.toLowerCase().includes(`документи за ${periodName}`) || !from || !m.envelope?.messageId) continue;
          if (/mailer-daemon|postmaster/i.test(from) || /^(automatic reply|out of office|автоматичен отговор)/i.test(subject)) continue;
          matching.push({
            uid: m.uid,
            messageId: m.envelope.messageId,
            from,
            subject,
            date: m.envelope.date ?? null,
          });
        }
      }
      for (const m of matching) {
        const part = await client.fetchOne(String(m.uid), { source: true }, { uid: true });
        if (!part || !part.source) continue;
        const parsed = await simpleParser(part.source);
        if (parsed.headers.get("auto-submitted") && parsed.headers.get("auto-submitted") !== "no") continue;
        replies.push({ messageId: m.messageId, from: m.from, subject: m.subject, date: m.date, text: parsed.text ?? "" });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return replies;
}

if (import.meta.main) {
  Deno.serve(handler);
}

async function handler(req: Request): Promise<Response> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  try {
    const body = await req.json().catch(() => ({}));

    const { data: setting, error: settingErr } = await supabase
      .from("automation_settings").select("value").eq("key", JOB_NAME).single();
    if (settingErr) throw settingErr;
    const { mode, test_recipient: testRecipient, test_limit: testLimit, report_recipient: reportTo } = setting.value;
    if (mode !== "test" && mode !== "live") throw new Error(`Непознат режим: ${mode}`);
    if (mode === "test" && !testRecipient) throw new Error("Липсва test_recipient");

    const { data: holidaysData, error: holidaysErr } = await supabase.from("holidays").select("holiday_date");
    if (holidaysErr) throw holidaysErr;
    const holidays = new Set((holidaysData ?? []).map((h: { holiday_date: string }) => h.holiday_date));

    const today = sofiaTodayISO();
    const [y, m, d] = today.split("-").map(Number);
    const schedule = monthSchedule(y, m, holidays);
    const force = mode === "test" && body.force === true;
    const stage = force ? (body.stage ?? null) : dueStage(today, schedule);
    const shouldScan = force || (today >= schedule.sendISO && d <= LAST_SCAN_DAY);

    if (!stage && !shouldScan) {
      return json({ ok: true, skipped: `няма работа днес`, mode });
    }

    const { data: activeClients, error: clientsErr } = await supabase
      .from("clients").select("id, name, contact_emails").eq("active", true);
    if (clientsErr) throw clientsErr;
    const allClients = [...(activeClients ?? [])].sort((a, b) => a.name.localeCompare(b.name, "bg"));

    const { data: vatRegistrations, error: vatErr } = await supabase
      .from("client_registrations")
      .select("client_id, started_on, ended_on, registration_types!inner ( code )")
      .eq("registration_types.code", "vat");
    if (vatErr) throw vatErr;
    const vatClientIds = new Set(
      (vatRegistrations ?? [])
        .filter((r) => r.started_on <= today && (!r.ended_on || r.ended_on >= today))
        .map((r) => r.client_id),
    );

    const errors: string[] = [];
    let repliesFound = 0;
    let scanFailed = false;

    if (shouldScan) {
      try {
        const monthStart = `${today.slice(0, 7)}-01`;
        let replies: Reply[] = [];
        for (let attempt = 1; attempt <= IMAP_ATTEMPTS; attempt++) {
          try {
            replies = await readReplies(monthStart, schedule.periodName);
            break;
          } catch (e) {
            if (attempt === IMAP_ATTEMPTS) throw e;
            await new Promise((r) => setTimeout(r, IMAP_RETRY_PAUSE_MS));
          }
        }
        for (const reply of replies) {
          const client = matchClient(reply.from, reply.subject, allClients, mode === "test" ? testRecipient : null);
          if (!client) continue;
          const classification = classifyReply(reply.text);
          const excerpt = stripQuoted(reply.text).slice(0, 2000);
          const { data: inserted, error: replyErr } = await supabase.from("client_reminder_replies").upsert({
            client_id: client.id,
            period_label: schedule.periodLabel,
            mode,
            message_id: reply.messageId,
            from_address: reply.from,
            subject: reply.subject,
            received_at: reply.date?.toISOString() ?? null,
            classification,
            excerpt,
          }, { onConflict: "message_id", ignoreDuplicates: true }).select("id");
          if (replyErr) { errors.push(`отговор ${client.name}: ${replyErr.message}`); continue; }
          if (!inserted || inserted.length === 0) continue;
          repliesFound++;

          // Съмнителен отговор: екипът го вижда в „Съобщения“ на
          // Органайзера. Само в live, за да не се пълни с тестове.
          if (classification === "question" && mode === "live") {
            const { error: msgErr } = await supabase.from("client_messages").insert({
              client_id: client.id,
              sender: "client",
              body: excerpt || "(празен отговор)",
              context_label: `Отговор на напомнянето за документи за ${schedule.periodName}`,
            });
            if (msgErr) errors.push(`съобщение ${client.name}: ${msgErr.message}`);
          }
        }
      } catch (e) {
        scanFailed = true;
        errors.push(`поща: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    let sent = 0;
    const results: { name: string; error: string | null }[] = [];
    const copyErrors: string[] = [];
    let sentFolder: SentFolder | null = null;

    // Без прочетена поща напомняния не тръгват: може да има клиент,
    // който вече е отговорил. Следващият пуск опитва пак.
    if (stage && !(scanFailed && stage > 1)) {
      const kind = kindForStage(stage);
      const { data: alreadySent, error: sentErr } = await supabase
        .from("client_reminders").select("client_id")
        .eq("kind", kind).eq("period_label", schedule.periodLabel).eq("mode", mode).eq("status", "sent");
      if (sentErr) throw sentErr;
      const sentIds = new Set((alreadySent ?? []).map((r: { client_id: string }) => r.client_id));

      let clients = allClients;
      if (stage > 1) {
        const { data: firstSent, error: firstErr } = await supabase
          .from("client_reminders").select("client_id")
          .eq("kind", KIND).eq("period_label", schedule.periodLabel).eq("mode", mode).eq("status", "sent");
        if (firstErr) throw firstErr;
        const { data: answered, error: answeredErr } = await supabase
          .from("client_reminder_replies").select("client_id")
          .eq("period_label", schedule.periodLabel).eq("mode", mode);
        if (answeredErr) throw answeredErr;
        const firstIds = new Set((firstSent ?? []).map((r: { client_id: string }) => r.client_id));
        const { data: confirmed, error: confirmedErr } = await supabase
          .from("client_document_status").select("client_id")
          .eq("period_label", schedule.periodLabel).eq("mode", mode).not("response", "is", null);
        if (confirmedErr) throw confirmedErr;
        const answeredIds = new Set(
          [...(answered ?? []), ...(confirmed ?? [])].map((r: { client_id: string }) => r.client_id),
        );
        clients = clients.filter((c) => firstIds.has(c.id) && !answeredIds.has(c.id));
      }
      if (mode === "test") {
        if (Array.isArray(body.only)) clients = clients.filter((c) => body.only.includes(c.name));
        clients = clients.slice(0, testLimit ?? 3);
      }

      const { error: statusErr } = await supabase.from("client_document_status").upsert(
        clients.map((c) => ({ client_id: c.id, period_label: schedule.periodLabel, mode })),
        { onConflict: "client_id,period_label,mode", ignoreDuplicates: true },
      );
      if (statusErr) throw statusErr;
      const { data: statuses, error: statusReadErr } = await supabase
        .from("client_document_status").select("client_id, token")
        .eq("period_label", schedule.periodLabel).eq("mode", mode);
      if (statusReadErr) throw statusReadErr;
      const tokens = new Map((statuses ?? []).map((r: { client_id: string; token: string }) => [r.client_id, r.token]));

      // Ако IMAP току-що не е отговорил, не го чакаме пак за копието в
      // „Изпратени“ — писмата са по-важни от копието.
      if (scanFailed) {
        copyErrors.push("папка „Изпратени“: пропуснато — IMAP не отговори при четенето на отговорите");
      } else {
        try {
          sentFolder = await openSentFolder();
        } catch (e) {
          copyErrors.push(`папка „Изпратени“: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      for (const client of clients) {
        if (sentIds.has(client.id)) continue;
        if (sent > 0) await new Promise((r) => setTimeout(r, SEND_PAUSE_MS));

        const isVat = vatClientIds.has(client.id);
        const confirmUrl = `${CONFIRM_PAGE}?t=${tokens.get(client.id)}`;
        const email = stage === 1
          ? buildEmail(client.name, schedule.periodName, schedule.deadlineISO, isVat, confirmUrl)
          : buildFollowUp(client.name, schedule.periodName, schedule.deadlineISO, stage, isVat, confirmUrl);
        const to: string[] = mode === "test" ? [testRecipient] : (client.contact_emails ?? []);
        const subject = mode === "test" ? `[ТЕСТ] ${email.subject}` : email.subject;
        const text = mode === "test"
          ? `ТЕСТ: реално писмо щеше да отиде до ${client.contact_emails?.length ?? 0} адрес(а) на ${client.name}.\n\n${email.text}`
          : email.text;

        const error = to.length === 0 ? "Няма имейл на клиента" : await sendEmail(to, subject, text, sentFolder, copyErrors);
        results.push({ name: client.name, error });
        if (error) errors.push(`${client.name}: ${error}`);
        else sent++;

        const { error: logErr } = await supabase.from("client_reminders").upsert({
          client_id: client.id,
          kind,
          period_label: schedule.periodLabel,
          mode,
          sent_to: to,
          status: error ? "failed" : "sent",
          error,
          sent_at: new Date().toISOString(),
        }, { onConflict: "client_id,kind,period_label,mode" });
        if (logErr) errors.push(`дневник ${client.name}: ${logErr.message}`);
      }
    }

    if (reportTo && (results.length > 0 || errors.length > 0 || copyErrors.length > 0)) {
      const report = buildReport(today, stage, schedule.periodName, results, errors, copyErrors);
      const reportError = await sendEmail([reportTo], report.subject, report.text, sentFolder, copyErrors);
      if (reportError) errors.push(`отчет: ${reportError}`);
    }
    if (sentFolder) await sentFolder.client.logout().catch(() => {});

    await supabase.from("cron_heartbeats").insert({
      job_name: JOB_NAME,
      status: errors.length === 0 && copyErrors.length === 0 ? "ok" : "error",
      details: `mode=${mode} period=${schedule.periodLabel} stage=${stage ?? "-"} sent=${sent} replies=${repliesFound} errors=${errors.length} copy_errors=${copyErrors.length}` +
        (errors.length ? ` :: ${errors.slice(0, 3).join(" | ")}` : ""),
    });

    return json({ ok: errors.length === 0, mode, period: schedule.periodLabel, stage, sent, replies: repliesFound, errors });
  } catch (e) {
    const message = e instanceof Error ? e.message : JSON.stringify(e);
    await supabase.from("cron_heartbeats").insert({ job_name: JOB_NAME, status: "error", details: message });
    return json({ ok: false, error: message }, 500);
  }
}
