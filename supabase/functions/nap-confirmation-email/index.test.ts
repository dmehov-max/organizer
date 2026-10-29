// Тестове за чистите функции в index.ts.
// Пускане: deno test supabase/functions/nap-confirmation-email/
//
// Текстовете по-долу са съкратени реални писма от eServices@nra.bg
// (21.10.2026, 13.07.2026, 29.10.2026) — без серийни номера на КЕП и
// линкове; полетата, които се парсват, са непроменени.

import { assert, assertEquals } from "jsr:@std/assert";
import {
  classifyDocument,
  type ClientRow,
  formatReference,
  htmlToText,
  normalizeNapName,
  overallResult,
  parseNapConfirmation,
  planTaskUpdate,
  referenceKey,
  resolveClient,
  secretsEqual,
} from "./index.ts";

// Обр. 1 + 6 — markdown таблица, както Gmail дава plain text. БЕЗ ЕИК.
const OBR16_MD = ` Потвърждение за получаване

| Доставчик на електронни административни услуги: | Национална агенция за приходите, ЕИК по БУЛСТАТ 131063188 |
|---|---|
| Уникален регистров идентификатор на получения документ: | 30E015846227 / 21.10.2026 13:19 |
|---|---|
| Заявител на електронната административна услуга: | АМБУЛАТОРИЯ ЗА ИНДИВИДУАЛНА ПЪРВИЧНА ДЕНТАЛНА ПОМОЩ - МИЛЕНИУМ ДЕНТАЛ КЕЪР |
|---|---|
| Подаден документ: | Декларация образец № 1 "Данни за осигуреното лице" и Декларация образец № 6 "Данни за дължими вноски и данък по ЗДДФЛ" за период 09/2026 |
|---|---|
POTVARZHDENIE ZA POLUCHAVANE
| Unikalen registrov identifikator na polucheniya dokument: | 30E015846227 / 21.10.2026 13:19 |
| Zayavitel na elektronnata administrativna usluga: | AMBULATORIYA |
CONFIRMATION OF RECEIPT
| Submitted document: | Declaration form No.1 for period 09/2026 |`;

// ДДС (InetVAT2) — ЕИК като "VIN BG…".
const VAT_MD = `| ПОТВЪРЖДЕНИЕ ЗА ПОЛУЧАВАНЕ |
| |
| Уникален регистров идентификатор на получения документ: | 30E012634936 / 13.07.2026 12:31:26 |
| Заявител на електронната административна услуга: | МЕХОВИ АУТО ЕООД, VIN BG208199054 |
| Подаден документ: | Месечна справка-декларация по ЗДДС за период: 202606 |
| Applicant of electronic administrative service: | МЕХОВИ АУТО ЕООД,, VIN BG208199054 |`;

// Чл. 55 — ЕИК „по ТР/БУЛСТАТ“, вид, който Органайзерът не следи.
const CHL55_MD = `| ПОТВЪРЖДЕНИЕ ЗА ПОЛУЧАВАНЕ |
| Уникален регистров идентификатор на получения документ: | 2210И2019538 / 29.10.2026 12:43:27 |
| Заявител на електронната административна услуга: | ДЖИ ДИ ЕМ ГРУП 2019, ЕИК по ТР/БУЛСТАТ 205482691 |
| Подаден документ: | Декларация по чл. 55, ал. 1 от ЗДДФЛ и чл. 201, ал. 1 от ЗКПО за 2026 г. за период: от 01.07.2026 до 30.09.2026 |`;

// Същото като OBR16, но като HTML — Apps Script праща getBody().
const OBR16_HTML = `<html><body><table>
<tr><td><b>Уникален регистров идентификатор на получения документ:</b></td><td>30E015846358 / 21.10.2026 13:21</td></tr>
<tr><td>Заявител на електронната административна услуга:</td><td>ВИЖУАЛАЙЗ</td></tr>
<tr><td>Подаден документ:</td><td>Декларация образец &#8470; 1 &quot;Данни за осигуреното лице&quot; и Декларация образец № 6 &quot;Данни&quot; за период 09/2026</td></tr>
</table></body></html>`;

const CLIENTS: ClientRow[] = [
  { id: "c-milenium", name: "АИПДП-МИЛЕНИУМ ДЕНТАЛ КЕЪР ЕООД", eik_egn: "207785185" },
  { id: "c-vizh", name: "ВИЖУАЛАЙЗ ООД", eik_egn: "206521026" },
  { id: "c-mehovi", name: "МЕХОВИ АУТО ЕООД", eik_egn: "208199054" },
  { id: "c-gdm", name: "ДЖИ ДИ ЕМ ГРУП", eik_egn: "202713730" },
  { id: "c-gdm19", name: "ДЖИ ДИ ЕМ ГРУП 2019 ЕООД", eik_egn: "205482691" },
];

// ---------- parseNapConfirmation() ----------

Deno.test("parse: обр. 1/6 — номер, дата, име без ЕИК, документ (само българската част)", () => {
  assertEquals(parseNapConfirmation(OBR16_MD), {
    referenceNumber: "30E015846227",
    referenceDate: "2026-10-21",
    applicantName: "АМБУЛАТОРИЯ ЗА ИНДИВИДУАЛНА ПЪРВИЧНА ДЕНТАЛНА ПОМОЩ - МИЛЕНИУМ ДЕНТАЛ КЕЪР",
    applicantEik: null,
    documentText:
      'Декларация образец № 1 "Данни за осигуреното лице" и Декларация образец № 6 "Данни за дължими вноски и данък по ЗДДФЛ" за период 09/2026',
  });
});

Deno.test("parse: ДДС — ЕИК от 'VIN BG…', името без него", () => {
  const p = parseNapConfirmation(VAT_MD)!;
  assertEquals(p.applicantEik, "208199054");
  assertEquals(p.applicantName, "МЕХОВИ АУТО ЕООД");
  assertEquals(p.referenceNumber, "30E012634936");
  assertEquals(p.referenceDate, "2026-07-13");
});

Deno.test("parse: чл. 55 — ЕИК 'по ТР/БУЛСТАТ', номер с кирилско И", () => {
  const p = parseNapConfirmation(CHL55_MD)!;
  assertEquals(p.applicantEik, "205482691");
  assertEquals(p.applicantName, "ДЖИ ДИ ЕМ ГРУП 2019");
  assertEquals(p.referenceNumber, "2210И2019538");
});

Deno.test("parse: HTML тяло (Apps Script getBody) дава същото", () => {
  const p = parseNapConfirmation(htmlToText(OBR16_HTML))!;
  assertEquals(p.referenceNumber, "30E015846358");
  assertEquals(p.applicantName, "ВИЖУАЛАЙЗ");
  assertEquals(classifyDocument(p.documentText), { codes: ["obr1", "obr6_monthly"], periodLabel: "2026-09" });
});

Deno.test("parse: друго писмо от НАП (без полетата) → null", () => {
  assertEquals(parseNapConfirmation("Резултат от обработка\nДокументът е приет."), null);
  assertEquals(parseNapConfirmation(""), null);
});

// ---------- classifyDocument() ----------

Deno.test("classify: обр. 1 и 6 заедно → двете задачи, период 09/2026 → 2026-09", () => {
  assertEquals(
    classifyDocument(parseNapConfirmation(OBR16_MD)!.documentText),
    { codes: ["obr1", "obr6_monthly"], periodLabel: "2026-09" },
  );
});

Deno.test("classify: само обр. 6 → само obr6_monthly (не хваща № 16 и др.)", () => {
  assertEquals(classifyDocument('Декларация образец № 6 "Данни" за период 08/2026'), {
    codes: ["obr6_monthly"],
    periodLabel: "2026-08",
  });
  assertEquals(classifyDocument("Декларация образец № 16 за период 08/2026"), null);
});

Deno.test("classify: ДДС период 202606 → 2026-06", () => {
  assertEquals(classifyDocument("Месечна справка-декларация по ЗДДС за период: 202606"), {
    codes: ["vat_declaration"],
    periodLabel: "2026-06",
  });
});

Deno.test("classify: чл. 55 / непознат вид / без период → null", () => {
  assertEquals(classifyDocument(parseNapConfirmation(CHL55_MD)!.documentText), null);
  assertEquals(classifyDocument("Декларация образец № 1 без период"), null);
});

// ---------- normalizeNapName() / resolveClient() ----------

Deno.test("normalizeNapName: маха правната форма и пунктуацията", () => {
  assertEquals(normalizeNapName("ВИЖУАЛАЙЗ ООД"), "ВИЖУАЛАЙЗ");
  assertEquals(normalizeNapName("Корект опаковки ООД"), "КОРЕКТ ОПАКОВКИ");
  assertEquals(normalizeNapName("ЕМ ВИ ЕМ - О ЕООД"), "ЕМ ВИ ЕМ О");
  assertEquals(normalizeNapName('"ХЕГЕТОР" ООД'), "ХЕГЕТОР");
});

Deno.test("resolveClient: ЕИК в писмото → по ЕИК", () => {
  assertEquals(resolveClient(parseNapConfirmation(VAT_MD)!, CLIENTS, new Map()), { clientId: "c-mehovi", matchedBy: "eik" });
});

Deno.test("resolveClient: чужд ЕИК → null, НЕ пада към името", () => {
  assertEquals(resolveClient({ applicantName: "ВИЖУАЛАЙЗ", applicantEik: "999999999" }, CLIENTS, new Map()), null);
});

Deno.test("resolveClient: име без правна форма = точно съвпадение (ВИЖУАЛАЙЗ ↔ ВИЖУАЛАЙЗ ООД)", () => {
  assertEquals(resolveClient({ applicantName: "ВИЖУАЛАЙЗ", applicantEik: null }, CLIENTS, new Map()), {
    clientId: "c-vizh",
    matchedBy: "name",
  });
});

Deno.test("resolveClient: 'ДЖИ ДИ ЕМ ГРУП' НЕ хваща 'ДЖИ ДИ ЕМ ГРУП 2019' (и обратно)", () => {
  assertEquals(resolveClient({ applicantName: "ДЖИ ДИ ЕМ ГРУП", applicantEik: null }, CLIENTS, new Map())?.clientId, "c-gdm");
  assertEquals(resolveClient({ applicantName: "ДЖИ ДИ ЕМ ГРУП 2019", applicantEik: null }, CLIENTS, new Map())?.clientId, "c-gdm19");
});

Deno.test("resolveClient: пълното име от НАП (амбулатория) без псевдоним → null; с псевдоним → клиентът", () => {
  const c = parseNapConfirmation(OBR16_MD)!;
  assertEquals(resolveClient(c, CLIENTS, new Map()), null);
  const aliases = new Map([[normalizeNapName(c.applicantName), "c-milenium"]]);
  assertEquals(resolveClient(c, CLIENTS, aliases), { clientId: "c-milenium", matchedBy: "alias" });
});

Deno.test("resolveClient: две фирми с едно и също нормализирано име → null", () => {
  const twins: ClientRow[] = [
    { id: "a", name: "ТЕСТ ООД", eik_egn: "111111111" },
    { id: "b", name: "ТЕСТ ЕООД", eik_egn: "222222222" },
  ];
  assertEquals(resolveClient({ applicantName: "ТЕСТ", applicantEik: null }, twins, new Map()), null);
});

// ---------- formatReference() / referenceKey() ----------

Deno.test("formatReference: във формата на колежките", () => {
  assertEquals(formatReference({ referenceNumber: "30E015846227", referenceDate: "2026-10-21" }), "30E015846227/21.10.2026");
});

Deno.test("referenceKey: различните ръчни записи на един номер са равни", () => {
  assertEquals(referenceKey("30E015846671"), "30E015846671");
  assertEquals(referenceKey("30E015846671/21.10.2026"), "30E015846671");
  assertEquals(referenceKey("22172838249 / 12.10.2026"), "22172838249");
});

// ---------- planTaskUpdate() ----------

const NOW = "2026-10-21T10:19:44.000Z";

Deno.test("planTaskUpdate: празна задача → отметка, дата, номер", () => {
  assertEquals(planTaskUpdate({ id: "t", stage_submission_done: false, submission_reference_number: null }, "30E1/21.10.2026", NOW), {
    outcome: "updated",
    update: { submission_reference_number: "30E1/21.10.2026", stage_submission_done: true, stage_submission_done_at: NOW },
  });
});

Deno.test("planTaskUpdate: отметнато на ръка без номер (Петанои) → само номерът, датата на отметката остава", () => {
  assertEquals(planTaskUpdate({ id: "t", stage_submission_done: true, submission_reference_number: null }, "30E1/21.10.2026", NOW), {
    outcome: "updated",
    update: { submission_reference_number: "30E1/21.10.2026" },
  });
});

Deno.test("planTaskUpdate: същият номер, вписан на ръка в друг формат → 'already', нищо не се пише", () => {
  assertEquals(
    planTaskUpdate({ id: "t", stage_submission_done: true, submission_reference_number: "30E015846671" }, "30E015846671/21.10.2026", NOW),
    { outcome: "already", update: null },
  );
});

Deno.test("planTaskUpdate: ДРУГ номер вписан на ръка → 'conflict', НЕ се презаписва", () => {
  assertEquals(
    planTaskUpdate({ id: "t", stage_submission_done: true, submission_reference_number: "30E999/01.10.2026" }, "30E1/21.10.2026", NOW),
    { outcome: "conflict", update: null },
  );
});

Deno.test("planTaskUpdate: НИКОГА не пипа статуса или 'Прието'", () => {
  const { update } = planTaskUpdate({ id: "t", stage_submission_done: false, submission_reference_number: null }, "30E1/21.10.2026", NOW);
  for (const k of ["status", "completed_at", "completed_by", "confirmation_status"]) assert(!(k in update!), k);
});

// ---------- overallResult() / secretsEqual() ----------

Deno.test("overallResult: updated > conflict > already > no_task", () => {
  assertEquals(overallResult(["already", "updated"]), "updated");
  assertEquals(overallResult(["already", "conflict"]), "conflict");
  assertEquals(overallResult(["already", "already"]), "already");
  assertEquals(overallResult([]), "no_task");
});

Deno.test("secretsEqual: само точно съвпадение; празно никога", () => {
  assert(secretsEqual("abc123", "abc123"));
  assert(!secretsEqual("abc123", "abc124"));
  assert(!secretsEqual("abc", "abc123"));
  assert(!secretsEqual("", ""));
});
