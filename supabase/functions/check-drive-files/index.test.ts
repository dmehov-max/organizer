// Тестове за чистите функции в index.ts (normalizeFolderName,
// folderNameMatchesClient, candidateMonthFolderNames, parseYearMonth).
// Пускане: deno test supabase/functions/check-drive-files/

import { assertEquals } from "jsr:@std/assert";
import {
  base64url,
  candidateMonthFolderNames,
  folderNameMatchesClient,
  normalizeFolderName,
  parseDeklarVatAmount,
  parseYearMonth,
  pemToArrayBuffer,
} from "./index.ts";

// Реален ред от СКРИЙН БОКС ООД/ДДС/07.2026/DEKLAR.txt (07.08.2026),
// само буквено-цифровата обвивка е скъсена/подменена с плейсхолдъри —
// числовата опашка (единствената, която се парсва) е непроменена.
const REAL_DEKLAR_LINE =
  "BG202990987    ПЛЕЙСХОЛДЪР ООД                                   2026077910037580/ПЛЕЙСХОЛДЪР ИМЕ                                  1              6         110.94          22.19         110.94          22.19           0.00           0.00           0.00           0.00           0.00           0.00           0.00           0.00           0.00           0.00           0.00           0.83         100.90          20.18           0.00           0.00           0.00           0.00          20.18           2.01           0.00           0.00           2.01           0.00           0.00           0.00";

// ---------- normalizeFolderName() ----------

Deno.test("normalizeFolderName: свива двойни интервали (реален случай в Firmi)", () => {
  assertEquals(normalizeFolderName("КОРЕКТ ПРЕМЕСТВАНЕ  ООД"), "корект преместване оод");
});

Deno.test("normalizeFolderName: тримва краищата", () => {
  assertEquals(normalizeFolderName("  Тест ЕООД  "), "тест еоод");
});

// ---------- folderNameMatchesClient() ----------

Deno.test("folderNameMatchesClient: точно съвпадение (без чувствителност към регистър/интервали)", () => {
  assertEquals(folderNameMatchesClient("Корект Преместване ООД", "корект преместване  оод"), true);
});

Deno.test("folderNameMatchesClient: папката съдържа името на клиента", () => {
  assertEquals(folderNameMatchesClient("Корект Преместване ООД (архив)", "Корект Преместване ООД"), true);
});

Deno.test("folderNameMatchesClient: различни клиенти не съвпадат", () => {
  assertEquals(folderNameMatchesClient("Ню Актърс ЕООД", "Тест ЕООД"), false);
});

Deno.test("folderNameMatchesClient: празно име не съвпада на сляпо", () => {
  assertEquals(folderNameMatchesClient("", "Тест ЕООД"), false);
  assertEquals(folderNameMatchesClient("Тест ЕООД", ""), false);
});

// ---------- candidateMonthFolderNames() ----------

Deno.test("candidateMonthFolderNames: съдържа реално наблюдавания формат MM.YYYY", () => {
  const candidates = candidateMonthFolderNames(2026, 6);
  assertEquals(candidates.includes("06.2026"), true);
});

Deno.test("candidateMonthFolderNames: подплатява месеца с нула", () => {
  const candidates = candidateMonthFolderNames(2026, 6);
  assertEquals(candidates.includes("06"), true);
  assertEquals(candidates.includes("6"), false);
});

Deno.test("candidateMonthFolderNames: декември не се разпада (12, не 012 никъде)", () => {
  const candidates = candidateMonthFolderNames(2026, 12);
  assertEquals(candidates.includes("12.2026"), true);
  assertEquals(candidates.includes("12"), true);
});

// ---------- parseYearMonth() ----------

Deno.test("parseYearMonth: валиден 'YYYY-MM'", () => {
  assertEquals(parseYearMonth("2026-06"), { year: 2026, month: 6 });
});

Deno.test("parseYearMonth: тримесечен етикет → null (извън обхвата на Drive проверката засега)", () => {
  assertEquals(parseYearMonth("2026-Q3"), null);
});

Deno.test("parseYearMonth: годишен етикет → null", () => {
  assertEquals(parseYearMonth("2026"), null);
});

// ---------- base64url() / pemToArrayBuffer() — JWT подпис helper-и ----------

Deno.test("base64url: няма padding и ползва URL-safe азбука", () => {
  const out = base64url("hello");
  assertEquals(out.includes("="), false);
  assertEquals(out.includes("+"), false);
  assertEquals(out.includes("/"), false);
});

Deno.test("base64url: обикновен текст кодира правилно (сверено с познат base64)", () => {
  // "hello" → base64 "aGVsbG8=" → без padding е "aGVsbG8"
  assertEquals(base64url("hello"), "aGVsbG8");
});

Deno.test("pemToArrayBuffer: маха header/footer/whitespace, дължината съвпада с декодирания base64", () => {
  // синтетичен "PEM" с известно съдържание — не истински ключ, само за формат
  const raw = "AAECAwQ="; // 4 байта: 00 01 02 03 04 (base64 на 5 байта всъщност — важно е само дължината)
  const pem = `-----BEGIN PRIVATE KEY-----\n${raw}\n-----END PRIVATE KEY-----\n`;
  const buf = pemToArrayBuffer(pem);
  assertEquals(new Uint8Array(buf).length, atob(raw).length);
});

// ---------- parseDeklarVatAmount() — реален пример, две независими проверки ----------

Deno.test("parseDeklarVatAmount: реален ред (ДДС за внасяне 2.01, кл.20-кл.40 съвпада с кл.71)", () => {
  assertEquals(parseDeklarVatAmount(REAL_DEKLAR_LINE), { amount: 2.01, direction: "due" });
});

Deno.test("parseDeklarVatAmount: нулева декларация (всичко 0.00)", () => {
  const zeros = Array(30).fill("0.00").join("          ");
  assertEquals(parseDeklarVatAmount(`заглавие ${zeros}`), { amount: 0, direction: "due" });
});

Deno.test("parseDeklarVatAmount: твърде малко числови полета → null (не рискува грешен формат)", () => {
  assertEquals(parseDeklarVatAmount("само 5.00 6.00 7.00 числа тук"), null);
});

// Реалните 30 числа от REAL_DEKLAR_LINE, като масив — за надеждно
// манипулиране по индекс в тестовете по-долу (string.replace върху
// ръчно набран текст е крехко към разлики в брой интервали).
const REAL_DEKLAR_NUMS = [
  "110.94", "22.19", "110.94", "22.19", "0.00", "0.00", "0.00", "0.00", "0.00",
  "0.00", "0.00", "0.00", "0.00", "0.00", "0.00", "0.83", "100.90", "20.18",
  "0.00", "0.00", "0.00", "0.00", "20.18", "2.01", "0.00", "0.00", "2.01",
  "0.00", "0.00", "0.00",
];

Deno.test("parseDeklarVatAmount: кл.50 не съвпада с изчисленото кл.20-кл.40 → null", () => {
  const tampered = [...REAL_DEKLAR_NUMS];
  tampered[23] = "9.99"; // кл.50, разминава се с кл.20-кл.40=2.01
  assertEquals(parseDeklarVatAmount(`заглавие ${tampered.join(" ")}`), null);
});

Deno.test("parseDeklarVatAmount: кл.71 не съвпада с кл.50 → null (кръстосаната проверка хваща разминаването)", () => {
  const tampered = [...REAL_DEKLAR_NUMS];
  tampered[26] = "9.99"; // кл.71, вече не съвпада с кл.50=2.01
  assertEquals(parseDeklarVatAmount(`заглавие ${tampered.join(" ")}`), null);
});

Deno.test("parseDeklarVatAmount: за възстановяване — кл.60 съвпада с |кл.20-кл.40|", () => {
  // синтетичен: кл.20=10.00 (idx1), кл.40=15.00 (idx22) → diff=-5.00 → кл.60(idx24) трябва да е 5.00
  const nums = Array(30).fill("0.00");
  nums[1] = "10.00"; nums[22] = "15.00"; nums[24] = "5.00";
  assertEquals(parseDeklarVatAmount(`заглавие ${nums.join(" ")}`), { amount: 5.00, direction: "refund" });
});
