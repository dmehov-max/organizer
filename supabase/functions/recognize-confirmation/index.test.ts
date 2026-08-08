// Тестове за чистите функции в index.ts (classify, guessTurnover).
// Пускане: deno test supabase/functions/recognize-confirmation/
//
// classify()-тестовете по-долу за Обр.1/6 са REGRESSION тестове за
// реален бъг, открит при живо тестване с истински НАП файл
// (2026-08-08): текстът има нов ред между "отхвърлени" и
// "Декларации обр.X:N", а "обр.1"/"обр.6" самите съдържат цифра —
// затова наивен regex, изключващ цифри в междинната част, спираше
// преждевременно и никога не стигаше до истинското число.

import { assertEquals } from "jsr:@std/assert";
import {
  classify,
  companyNamesMatch,
  extractDeclaredCompanyName,
  extractDeclaredEik,
  extractReferenceNumber,
  guessTurnover,
  normalizeCompanyName,
} from "./index.ts";

// ---------- classify() — реален формат на Обр. 1/6 съобщение ----------

Deno.test("classify: Обр.1/6 — всичко прието (реален текст, нула отхвърлени)", () => {
  const text = `
    За общ брой декларации обр.1: 5
    За общ брой декларации обр.6: 1
    Брой подадени Декларации обр.1: 5 Брой приети Декларации обр.1:5 Брой отхвърлени
    Декларации обр.1:0
    Брой подадени Декларации обр.6:1 Брой приети Декларации обр.6:1 Брой отхвърлени
    Декларации обр.6:0
  `;
  assertEquals(classify(text), "accepted");
});

Deno.test("classify: Обр.1/6 — с една отхвърлена декларация", () => {
  const text = `
    Брой подадени Декларации обр.1: 5 Брой приети Декларации обр.1:4 Брой отхвърлени
    Декларации обр.1:1
    Брой подадени Декларации обр.6:1 Брой приети Декларации обр.6:1 Брой отхвърлени
    Декларации обр.6:0
  `;
  assertEquals(classify(text), "rejected");
});

Deno.test("classify: не бърка нулев брой отхвърлени с истински отказ (стар бъг)", () => {
  // Само думата "отхвърлени" се среща — наивна проверка за
  // присъствие на думата би маркирала това погрешно като "rejected".
  const text = "Брой отхвърлени Декларации обр.1:0";
  assertEquals(classify(text), "accepted");
});

Deno.test("classify: прескача цифрата в 'обр.1'/'обр.6' по пътя към двоеточието", () => {
  // Регресия за конкретния бъг: междинният текст СЪДЪРЖА цифра
  // ("обр.1"), и то на нов ред — не бива regex-ът да спира на нея.
  const text = "Брой отхвърлени\nДекларации обр.1:0\nБрой отхвърлени\nДекларации обр.6:0";
  assertEquals(classify(text), "accepted");
});

// ---------- classify() — прости фразови формати (ДДС, чл.55) ----------

Deno.test("classify: ДДС 'Уведомление за приемане' → accepted", () => {
  const text = "УВЕДОМЛЕНИЕ ЗА ПРИЕМАНЕ НА данни от Справката-декларация за ДДС";
  assertEquals(classify(text), "accepted");
});

Deno.test("classify: чл.55 'е приета' → accepted", () => {
  const text = "Подадената от Вас Декларация по чл. 55, ал. 1 от ЗДДФЛ е приета.";
  assertEquals(classify(text), "accepted");
});

Deno.test("classify: изрична фраза за отказ → rejected", () => {
  const text = "Декларацията не е приета поради грешка в данните.";
  assertEquals(classify(text), "rejected");
});

Deno.test("classify: неразпознаваем текст → null (не гадае)", () => {
  const text = "Някакъв съвсем друг документ без ключови думи.";
  assertEquals(classify(text), null);
});

Deno.test("classify: не е чувствителен към регистър", () => {
  assertEquals(classify("ДЕКЛАРАЦИЯТА Е ПРИЕТА."), "accepted");
});

// ---------- guessTurnover() ----------

Deno.test("guessTurnover: намира число след 'нетни приходи от продажби'", () => {
  const text = "Нетни приходи от продажби: 125 430,50 лв.";
  assertEquals(guessTurnover(text), 125430.50);
});

Deno.test("guessTurnover: намира число след 'оборот'", () => {
  const text = "Годишен оборот: 50000,00 лв.";
  assertEquals(guessTurnover(text), 50000);
});

Deno.test("guessTurnover: връща null, ако няма съвпадение", () => {
  assertEquals(guessTurnover("Текст без финансови данни."), null);
});

// ---------- extractReferenceNumber() — реални формати ----------

Deno.test("extractReferenceNumber: ДДС формат 'ВХОДЯЩ НОМЕР НА ДАННИТЕ'", () => {
  const text = "ВХОДЯЩ НОМЕР НА ДАННИТЕ: ДДС.2215-2676743\nДАТА: 13/02/2026";
  assertEquals(extractReferenceNumber(text), "ДДС.2215-2676743");
});

Deno.test("extractReferenceNumber: чл.55/Обр.1-6 формат 'Вх. №'", () => {
  assertEquals(extractReferenceNumber("Вх. №: 2215И0741032 / 24.07.2026"), "2215И0741032");
  assertEquals(extractReferenceNumber("Вх. № 30E012889408/20.07.2026 13:45:42"), "30E012889408");
});

Deno.test("extractReferenceNumber: null при липса на входящ номер", () => {
  assertEquals(extractReferenceNumber("Съвсем друг текст."), null);
});

// ---------- extractDeclaredEik() ----------

Deno.test("extractDeclaredEik: 'ЕГН/ЛНЧ/Сл.номер/ЕИК по БУЛСТАТ'", () => {
  const text = "ЕГН/ЛНЧ/Сл.номер/ЕИК по БУЛСТАТ: 175323940";
  assertEquals(extractDeclaredEik(text), "175323940");
});

Deno.test("extractDeclaredEik: ДДС номер формат BG+ЕИК", () => {
  const text = "постъпили от: КОРЕКТ - ОПАКОВКИ ООД , с VIN BG205970324";
  assertEquals(extractDeclaredEik(text), "205970324");
});

Deno.test("extractDeclaredEik: null при липса", () => {
  assertEquals(extractDeclaredEik("Текст без ЕИК."), null);
});

// ---------- extractDeclaredCompanyName() ----------

Deno.test("extractDeclaredCompanyName: 'Името на:' формат", () => {
  assertEquals(extractDeclaredCompanyName("Името на: ЕЙНДЖЪЛ СТИЛ\nЕГН/ЛНЧ..."), "ЕЙНДЖЪЛ СТИЛ");
});

// ---------- normalizeCompanyName() / companyNamesMatch() ----------

Deno.test("normalizeCompanyName: маха правна форма и пунктуация", () => {
  assertEquals(normalizeCompanyName("КОРЕКТ - ОПАКОВКИ ООД"), "корект опаковки");
  assertEquals(normalizeCompanyName("Корект Опаковки"), "корект опаковки");
});

Deno.test("companyNamesMatch: съвпада въпреки различно изписване", () => {
  assertEquals(companyNamesMatch("КОРЕКТ - ОПАКОВКИ ООД", "Корект Опаковки"), true);
});

Deno.test("companyNamesMatch: различни фирми не съвпадат", () => {
  assertEquals(companyNamesMatch("ЕЙНДЖЪЛ СТИЛ", "ТЕСТ ЕООД"), false);
});

Deno.test("companyNamesMatch: празен вход не вдига лъжлива тревога", () => {
  assertEquals(companyNamesMatch("", "Корект Опаковки"), true);
});
