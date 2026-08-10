// Тестове за чистите функции в index.ts (normalizeFolderName,
// folderNameMatchesClient, candidateMonthFolderNames, parseYearMonth).
// Пускане: deno test supabase/functions/check-drive-files/

import { assertEquals } from "jsr:@std/assert";
import {
  base64url,
  candidateMonthFolderNames,
  folderNameMatchesClient,
  normalizeFolderName,
  parseYearMonth,
  pemToArrayBuffer,
} from "./index.ts";

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
