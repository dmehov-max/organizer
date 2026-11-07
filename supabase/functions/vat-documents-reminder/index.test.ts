// Тестове за чистите функции на vat-documents-reminder (графикът на
// писмата, разпознаването на отговори) + правилата за изпращане
// (07.11.2026: пауза между писмата, повторен опит за IMAP).
// Пускане: deno test --allow-net --allow-env --allow-sys supabase/functions/vat-documents-reminder/
// (--allow-sys заради imapflow/pino, които питат за hostname при import)

import { assert, assertEquals } from "jsr:@std/assert";
import {
  buildEmail,
  buildFollowUp,
  classifyReply,
  dueStage,
  findTextPart,
  htmlToText,
  IMAP_ATTEMPTS,
  IMAP_READ_DEADLINE_MS,
  IMAP_RETRY_PAUSE_MS,
  kindForStage,
  matchClient,
  monthSchedule,
  SEND_PAUSE_MS,
  stripQuoted,
} from "./index.ts";

const NO_HOLIDAYS = new Set<string>();

// ---------- графикът ----------

Deno.test("monthSchedule: ноември 2026 — 1.11 е неделя → първото писмо на 2.11; срок 5.11; 2-ро 6.11 (7-и е събота); 3-то 10.11", () => {
  const s = monthSchedule(2026, 11, NO_HOLIDAYS);
  assertEquals(s.sendISO, "2026-11-02");
  assertEquals(s.deadlineISO, "2026-11-05");
  assertEquals(s.secondISO, "2026-11-06");
  assertEquals(s.thirdISO, "2026-11-10");
  assertEquals(s.periodLabel, "2026-10");
  assertEquals(s.periodName, "октомври 2026");
});

Deno.test("monthSchedule: официален празник измества първия работен ден", () => {
  const s = monthSchedule(2026, 1, new Set(["2026-01-01", "2026-01-02"]));
  assertEquals(s.sendISO, "2026-01-05"); // 1-2 празник, 3-4 уикенд
});

Deno.test("monthSchedule: второто напомняне никога не е в деня на срока или преди него", () => {
  for (const m of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const s = monthSchedule(2026, m, NO_HOLIDAYS);
    assert(s.secondISO > s.deadlineISO, `${m}: second ${s.secondISO} <= deadline ${s.deadlineISO}`);
    assert(s.thirdISO > s.secondISO, `${m}: third ${s.thirdISO} <= second ${s.secondISO}`);
  }
});

Deno.test("dueStage: денят на писмото и 2 дни след него; извън прозореца → null", () => {
  const s = { sendISO: "2026-11-02", secondISO: "2026-11-06", thirdISO: "2026-11-10" };
  assertEquals(dueStage("2026-11-01", s), null);
  assertEquals(dueStage("2026-11-02", s), 1);
  assertEquals(dueStage("2026-11-04", s), 1);
  assertEquals(dueStage("2026-11-05", s), null);
  assertEquals(dueStage("2026-11-07", s), 2);
  assertEquals(dueStage("2026-11-09", s), null);
  assertEquals(dueStage("2026-11-12", s), 3);
  assertEquals(dueStage("2026-11-20", s), null);
});

Deno.test("kindForStage: първото писмо е без суфикс", () => {
  assertEquals(kindForStage(1), "vat_documents");
  assertEquals(kindForStage(2), "vat_documents_2");
});

// ---------- правила за изпращане ----------

Deno.test("изпращане: пауза между писмата ≥ 3 с и ≤ 10 с (35 писма трябва да се поберат във функцията)", () => {
  assert(SEND_PAUSE_MS >= 3000 && SEND_PAUSE_MS <= 10000, String(SEND_PAUSE_MS));
});

Deno.test("IMAP: поне два опита преди отказ за деня", () => {
  assert(IMAP_ATTEMPTS >= 2);
});

Deno.test("IMAP: всички опити + паузите се побират под 120 с (лимитът на шлюза е 150 с)", () => {
  const worst = IMAP_ATTEMPTS * IMAP_READ_DEADLINE_MS + (IMAP_ATTEMPTS - 1) * IMAP_RETRY_PAUSE_MS;
  assert(worst <= 120_000, String(worst));
});

// ---------- отговори ----------

Deno.test("stripQuoted: маха цитираното писмо отдолу", () => {
  assertEquals(stripQuoted("Качено.\n\nOn Mon, X wrote:\n> стар текст"), "Качено.");
  assertEquals(stripQuoted("Готово\n> цитат"), "Готово");
});

Deno.test("classifyReply: 'ще кача утре' е въпрос, не готово", () => {
  assertEquals(classifyReply("Ще кача утре"), "question");
  assertEquals(classifyReply("Качих всичко"), "done");
  assertEquals(classifyReply("Нямаме документи за месеца"), "done");
  assertEquals(classifyReply("Кой месец имате предвид?"), "question");
  assertEquals(classifyReply(""), "question");
});

Deno.test("matchClient: по адрес на подателя; при обща поща името в темата решава", () => {
  const clients = [
    { id: "a", name: "ПРИМЕРНА ФИРМА ООД", contact_emails: ["shared@example.com"] },
    { id: "b", name: "ДРУГА ФИРМА ЕООД", contact_emails: ["shared@example.com"] },
    { id: "c", name: "ТРЕТА ЕООД", contact_emails: ["treta@example.com"] },
  ];
  assertEquals(matchClient("treta@example.com", "Re: Документи за октомври 2026 – ТРЕТА ЕООД", clients, null)?.id, "c");
  assertEquals(matchClient("shared@example.com", "Re: Документи за октомври 2026 – ДРУГА ФИРМА ЕООД", clients, null)?.id, "b");
  assertEquals(matchClient("shared@example.com", "Re: без име", clients, null), null);
  assertEquals(matchClient("stranger@example.com", "Re: ТРЕТА ЕООД", clients, null), null);
});

// ---------- текстове ----------

Deno.test("buildEmail: ДДС фирма — строг текст със срок; без ДДС — „с цел по-добра отчетност“", () => {
  const vat = buildEmail("ПРИМЕРНА ФИРМА ООД", "октомври 2026", "2026-11-05", true, "https://x/confirm.html?t=1");
  assert(vat.text.includes("Напомняме Ви") && vat.text.includes("05.11.2026"));
  assert(vat.text.includes("приходните документи"));
  const nonVat = buildEmail("ПРИМЕРНА ФИРМА ООД", "октомври 2026", "2026-11-05", false, "https://x/confirm.html?t=1");
  assert(nonVat.text.includes("по-добра отчетност"));
  assertEquals(vat.subject, "Документи за октомври 2026 – ПРИМЕРНА ФИРМА ООД");
});

Deno.test("buildFollowUp: второ и трето писмо имат различно начало и линка за потвърждение", () => {
  const s2 = buildFollowUp("X", "октомври 2026", "2026-11-05", 2, true, "https://x/c?t=1");
  const s3 = buildFollowUp("X", "октомври 2026", "2026-11-05", 3, true, "https://x/c?t=1");
  assert(s2.subject.startsWith("Напомняне:"));
  assert(s3.subject.startsWith("Второ напомняне:"));
  assert(s2.text.includes("https://x/c?t=1"));
});

// ---------- четене на отговора по IMAP ----------

Deno.test("findTextPart: предпочита text/plain, иначе text/html; едночастно писмо е част 1", () => {
  const multi = { type: "multipart/alternative", childNodes: [{ part: "1", type: "text/plain" }, { part: "2", type: "text/html" }] };
  assertEquals(findTextPart(multi), { part: "1", html: false });
  const htmlOnly = { type: "multipart/mixed", childNodes: [{ part: "1", type: "text/html" }, { part: "2", type: "application/pdf" }] };
  assertEquals(findTextPart(htmlOnly), { part: "1", html: true });
  assertEquals(findTextPart({ type: "text/plain" }), { part: "1", html: false });
  assertEquals(findTextPart({ type: "application/pdf" }), null);
  assertEquals(findTextPart(undefined), null);
});

Deno.test("htmlToText: маха таговете и стила, пази редовете", () => {
  const t = htmlToText("<html><style>p{}</style><body><p>Качено.</p><div>Поздрави &amp; благодаря</div></body></html>");
  assert(t.startsWith("Качено."));
  assert(t.includes("Поздрави & благодаря"));
  assert(!t.includes("<"));
});
