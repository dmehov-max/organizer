// Тестове за чистите функции в index.ts (normalizeFolderName,
// folderNameMatchesClient, candidateMonthFolderNames, parseYearMonth).
// Пускане: deno test supabase/functions/check-drive-files/

import { assert, assertEquals } from "jsr:@std/assert";
import {
  base64url,
  buildDeclarationUpdate,
  candidateMonthFolderNames,
  DECLARATION_FILES,
  declarationSearchQuery,
  type DriveFile,
  EXCLUDED_FROM_FOLDER_HEURISTIC,
  folderNameMatchesClient,
  isValidDriveFolderId,
  isValidEik,
  normalizeFolderName,
  parseDeklarVatAmount,
  parseNapDeclarationFileName,
  parseYearMonth,
  pemToArrayBuffer,
  pickDeclarationFile,
  resolveClientFolder,
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

// =====================================================================
// Декл. обр. 1 / обр. 6 — засичане по име на файла (DECLARATIONS.md).
// Имената по-долу са реални имена от Firmi папката (20.10.2026).
// =====================================================================

const TXT = "text/plain";
const file = (name: string, modifiedTime?: string, mimeType = TXT): DriveFile =>
  ({ id: name, name, mimeType, modifiedTime });
const WANT_OBR1_SEP = { kind: "obr1" as const, eik: "204470152", year: 2026, month: 9 };

// ---------- parseNapDeclarationFileName() — добри случаи ----------

Deno.test("parseNapDeclarationFileName: обр.1 (EMPL2021), реално име", () => {
  assertEquals(parseNapDeclarationFileName("EMPL2021_204470152_09.2026_1.TXT"),
    { kind: "obr1", eik: "204470152", year: 2026, month: 9 });
});

Deno.test("parseNapDeclarationFileName: обр.6 (NRA62007), реално име", () => {
  assertEquals(parseNapDeclarationFileName("NRA62007_175323940_12.2025_1.TXT"),
    { kind: "obr6", eik: "175323940", year: 2025, month: 12 });
});

Deno.test("parseNapDeclarationFileName: пореден номер >1 (корекция, '_5'/'_6') се приема", () => {
  assertEquals(parseNapDeclarationFileName("EMPL2021_175323940_07.2026_6.TXT")?.kind, "obr1");
});

Deno.test("parseNapDeclarationFileName: ръчно преименувано копие '_1з' се приема (реален случай)", () => {
  assertEquals(parseNapDeclarationFileName("NRA62007_204186426_01.2026_1з.TXT")?.kind, "obr6");
});

Deno.test("parseNapDeclarationFileName: малки букви в разширението/префикса", () => {
  assertEquals(parseNapDeclarationFileName("empl2021_204470152_09.2026_1.txt")?.kind, "obr1");
});

Deno.test("parseNapDeclarationFileName: бъдеща версия на формата (EMPL2027) се разпознава", () => {
  assertEquals(parseNapDeclarationFileName("EMPL2027_204470152_09.2026_1.TXT")?.kind, "obr1");
});

Deno.test("parseNapDeclarationFileName: 13-цифрен ЕИК на клон", () => {
  assertEquals(parseNapDeclarationFileName("EMPL2021_2044701520001_09.2026_1.TXT")?.eik, "2044701520001");
});

// ---------- parseNapDeclarationFileName() — лоши случаи ----------

Deno.test("parseNapDeclarationFileName: PDF преглед на обр.6 НЕ е декларацията", () => {
  assertEquals(parseNapDeclarationFileName("Преглед на Декларация Обр. 6.pdf"), null);
});

Deno.test("parseNapDeclarationFileName: другите ТРЗ файлове в папката → null", () => {
  for (const n of [
    "РПВ СОЛ 2026.09.pdf",
    "Дължими вноски към НАП - кратка 2026.09.pdf",
    "Рекапитулация - стандартна 2026.09.pdf",
    "ПЛАТЕЖНИ.pdf",
    "ETZ175323940.xml",
    "DEKLAR.txt",
  ]) assertEquals(parseNapDeclarationFileName(n), null, n);
});

Deno.test("parseNapDeclarationFileName: правилен префикс, но не .TXT (.pdf/.zip) → null", () => {
  assertEquals(parseNapDeclarationFileName("EMPL2021_204470152_09.2026_1.pdf"), null);
  assertEquals(parseNapDeclarationFileName("EMPL2021_204470152_09.2026_1.TXT.zip"), null);
});

Deno.test("parseNapDeclarationFileName: невалиден месец (00, 13) → null", () => {
  assertEquals(parseNapDeclarationFileName("EMPL2021_204470152_00.2026_1.TXT"), null);
  assertEquals(parseNapDeclarationFileName("EMPL2021_204470152_13.2026_1.TXT"), null);
});

Deno.test("parseNapDeclarationFileName: месец без водеща нула ('9.2026') → null", () => {
  assertEquals(parseNapDeclarationFileName("EMPL2021_204470152_9.2026_1.TXT"), null);
});

Deno.test("parseNapDeclarationFileName: ЕИК с букви или твърде къс → null", () => {
  assertEquals(parseNapDeclarationFileName("EMPL2021_BG204470152_09.2026_1.TXT"), null);
  assertEquals(parseNapDeclarationFileName("EMPL2021_2044_09.2026_1.TXT"), null);
});

Deno.test("parseNapDeclarationFileName: без пореден номер → null", () => {
  assertEquals(parseNapDeclarationFileName("EMPL2021_204470152_09.2026.TXT"), null);
});

Deno.test("parseNapDeclarationFileName: случаен файл с подобно начало ('EMPL_backup.txt') → null", () => {
  assertEquals(parseNapDeclarationFileName("EMPL_backup.txt"), null);
  assertEquals(parseNapDeclarationFileName("NRA6.txt"), null);
});

Deno.test("parseNapDeclarationFileName: празно име → null", () => {
  assertEquals(parseNapDeclarationFileName(""), null);
});

// ---------- isValidEik() ----------

Deno.test("isValidEik: 9/10/13 цифри са валидни", () => {
  assert(isValidEik("204470152"));
  assert(isValidEik("8001011234"));
  assert(isValidEik("2044701520001"));
});

Deno.test("isValidEik: null/празно/с букви/с BG/с интервал → невалиден", () => {
  for (const v of [null, undefined, "", "BG204470152", "204 470 152", "20447015", "12345678901"]) {
    assertEquals(isValidEik(v), false, String(v));
  }
});

// ---------- declarationSearchQuery() ----------

Deno.test("declarationSearchQuery: точен prefix за Drive, без папки и кошче", () => {
  assertEquals(
    declarationSearchQuery("EMPL2021", "204470152", 2026, 9),
    "name contains 'EMPL2021_204470152_09.2026' and trashed = false and mimeType != 'application/vnd.google-apps.folder'",
  );
});

Deno.test("declarationSearchQuery: инжекция през ЕИК (кавичка) → null, никаква заявка", () => {
  assertEquals(declarationSearchQuery("EMPL2021", "204470152' or name contains '", 2026, 9), null);
});

Deno.test("declarationSearchQuery: инжекция през префикс → null", () => {
  assertEquals(declarationSearchQuery("EMPL' or '1'='1", "204470152", 2026, 9), null);
});

Deno.test("declarationSearchQuery: невалиден период → null", () => {
  assertEquals(declarationSearchQuery("EMPL2021", "204470152", 2026, 0), null);
  assertEquals(declarationSearchQuery("EMPL2021", "204470152", 2026, 13), null);
  assertEquals(declarationSearchQuery("EMPL2021", "204470152", 26, 9), null);
  assertEquals(declarationSearchQuery("EMPL2021", "204470152", NaN, 9), null);
});

// ---------- pickDeclarationFile() — лоши сценарии ----------

Deno.test("pickDeclarationFile: няма резултати → null (декларацията още не е генерирана)", () => {
  assertEquals(pickDeclarationFile([], WANT_OBR1_SEP), null);
});

Deno.test("pickDeclarationFile: файл на ДРУГА фирма (друг ЕИК) не маркира", () => {
  assertEquals(pickDeclarationFile([file("EMPL2021_175323940_09.2026_1.TXT")], WANT_OBR1_SEP), null);
});

Deno.test("pickDeclarationFile: 13-цифрен ЕИК на клон, започващ със същия ЕИК, не маркира фирмата", () => {
  // Drive "contains" е prefix-търсене — ще върне и клона; трябва да го отсеем.
  assertEquals(pickDeclarationFile([file("EMPL2021_2044701520001_09.2026_1.TXT")], WANT_OBR1_SEP), null);
});

Deno.test("pickDeclarationFile: файл за ДРУГ месец (август в септемврийска папка) не маркира септември", () => {
  assertEquals(pickDeclarationFile([file("EMPL2021_204470152_08.2026_1.TXT")], WANT_OBR1_SEP), null);
});

Deno.test("pickDeclarationFile: същият месец, ДРУГА година не маркира", () => {
  assertEquals(pickDeclarationFile([file("EMPL2021_204470152_09.2025_1.TXT")], WANT_OBR1_SEP), null);
});

Deno.test("pickDeclarationFile: само обр.6 е генериран → обр.1 НЕ се маркира", () => {
  assertEquals(pickDeclarationFile([file("NRA62007_204470152_09.2026_1.TXT")], WANT_OBR1_SEP), null);
});

Deno.test("pickDeclarationFile: само обр.1 е генериран → обр.6 НЕ се маркира", () => {
  assertEquals(
    pickDeclarationFile([file("EMPL2021_204470152_09.2026_1.TXT")], { ...WANT_OBR1_SEP, kind: "obr6" }),
    null,
  );
});

Deno.test("pickDeclarationFile: ПАПКА с име като декларацията не се брои", () => {
  assertEquals(
    pickDeclarationFile(
      [file("EMPL2021_204470152_09.2026_1.TXT", undefined, "application/vnd.google-apps.folder")],
      WANT_OBR1_SEP,
    ),
    null,
  );
});

Deno.test("pickDeclarationFile: PDF преглед до TXT-то — избира TXT-то", () => {
  const picked = pickDeclarationFile([
    file("Преглед на Декларация Обр. 6.pdf", "2026-10-01T00:00:00Z"),
    file("EMPL2021_204470152_09.2026_1.TXT", "2026-10-19T10:00:00Z"),
  ], WANT_OBR1_SEP);
  assertEquals(picked?.name, "EMPL2021_204470152_09.2026_1.TXT");
});

Deno.test("pickDeclarationFile: няколко копия (ТРЗ\\ + месечната папка, корекция) → най-ранното", () => {
  const picked = pickDeclarationFile([
    file("EMPL2021_204470152_09.2026_5.TXT", "2026-10-19T12:00:00Z"),
    file("EMPL2021_204470152_09.2026_1.TXT", "2026-10-15T08:00:00Z"),
    file("EMPL2021_204470152_09.2026_1.TXT", "2026-10-16T08:00:00Z"),
  ], WANT_OBR1_SEP);
  assertEquals(picked?.modifiedTime, "2026-10-15T08:00:00Z");
});

Deno.test("pickDeclarationFile: файл без/с невалидна дата не чупи избора, отива последен", () => {
  const picked = pickDeclarationFile([
    file("EMPL2021_204470152_09.2026_1.TXT", "не-е-дата"),
    file("EMPL2021_204470152_09.2026_2.TXT"),
    file("EMPL2021_204470152_09.2026_3.TXT", "2026-10-19T12:00:00Z"),
  ], WANT_OBR1_SEP);
  assertEquals(picked?.name, "EMPL2021_204470152_09.2026_3.TXT");
});

Deno.test("pickDeclarationFile: само файлове без дата → все пак намира", () => {
  assertEquals(
    pickDeclarationFile([file("EMPL2021_204470152_09.2026_1.TXT")], WANT_OBR1_SEP)?.name,
    "EMPL2021_204470152_09.2026_1.TXT",
  );
});

// ---------- buildDeclarationUpdate() ----------

const NOW = "2026-10-20T09:00:00.000Z";

Deno.test("buildDeclarationUpdate: неотметнато 'Създаване' → отмята с датата на файла", () => {
  const u = buildDeclarationUpdate({ stage_creation_done: false }, file("x", "2026-10-19T10:00:00Z"), NOW);
  assertEquals(u.stage_creation_done, true);
  assertEquals(u.stage_creation_done_at, "2026-10-19T10:00:00.000Z");
  assertEquals(u.files_generated_detected_at, NOW);
  assertEquals(u.files_generated_detected_path, "x");
});

Deno.test("buildDeclarationUpdate: вече РЪЧНО отметнато → не пипа отметката и датата ѝ", () => {
  const u = buildDeclarationUpdate({ stage_creation_done: true }, file("x", "2026-10-19T10:00:00Z"), NOW);
  assertEquals("stage_creation_done" in u, false);
  assertEquals("stage_creation_done_at" in u, false);
  assertEquals(u.files_generated_detected_at, NOW);
});

Deno.test("buildDeclarationUpdate: дата на файла в бъдещето → ползва 'сега'", () => {
  const u = buildDeclarationUpdate({ stage_creation_done: false }, file("x", "2027-01-01T00:00:00Z"), NOW);
  assertEquals(u.stage_creation_done_at, NOW);
});

Deno.test("buildDeclarationUpdate: липсваща/невалидна дата на файла → ползва 'сега'", () => {
  assertEquals(buildDeclarationUpdate({}, file("x"), NOW).stage_creation_done_at, NOW);
  assertEquals(buildDeclarationUpdate({ stage_creation_done: null }, file("x", "боклук"), NOW).stage_creation_done_at, NOW);
});

Deno.test("buildDeclarationUpdate: НИКОГА не пипа статуса, проверката или подаването", () => {
  const u = buildDeclarationUpdate({ stage_creation_done: false }, file("x", "2026-10-19T10:00:00Z"), NOW);
  for (const k of ["status", "stage_review_done", "stage_submission_done", "completed_at"]) {
    assertEquals(k in u, false, k);
  }
});

// ---------- конфигурация ----------

Deno.test("DECLARATION_FILES: обр.1 ↔ EMPL, обр.6 ↔ NRA6, префиксите се разпознават от парсера", () => {
  assertEquals(DECLARATION_FILES.obr1.kind, "obr1");
  assertEquals(DECLARATION_FILES.obr6_monthly.kind, "obr6");
  for (const [code, d] of Object.entries(DECLARATION_FILES)) {
    for (const p of d.searchPrefixes) {
      assertEquals(parseNapDeclarationFileName(`${p}_204470152_09.2026_1.TXT`)?.kind, d.kind, code);
    }
  }
});

Deno.test("EXCLUDED_FROM_FOLDER_HEURISTIC: декларациите и имейлът за вноски не се маркират от 'има нещо в папката'", () => {
  for (const c of ["obr1", "obr6_monthly", "contributions_email"]) assert(EXCLUDED_FROM_FOLDER_HEURISTIC.has(c), c);
  assertEquals(EXCLUDED_FROM_FOLDER_HEURISTIC.has("vat_declaration"), false);
});

// ---------- resolveClientFolder() — папка по clients.drive_folder_id (0073) ----------

// Реални имена от Firmi (28.10.2026), ID-тата са измислени.
const FIRMI_TOP = [
  { id: "folder_gdm_grup_xx", name: "ДЖИ ДИ ЕМ ГРУП 2019" },
  { id: "folder_korekt_prem", name: "КОРЕКТ ПРЕМЕСТВАНЕ  ООД" },
  { id: "folder_pentanoi_xx", name: "ПЕНТАНОИ ЕООД" },
  { id: "folder_screen_boxx", name: "СКРИЙН БОКС ООД" },
];

Deno.test("resolveClientFolder: има drive_folder_id → ползва него, без да чака списъка с папки", () => {
  assertEquals(
    resolveClientFolder({ name: "Петанои", drive_folder_id: "1sj4gMIT3Xq57uup3qjE6Guh6yUdheofv" }, null),
    { id: "1sj4gMIT3Xq57uup3qjE6Guh6yUdheofv", name: "Петанои", source: "id" },
  );
});

Deno.test("resolveClientFolder: ID-то печели пред съвпадение по име (ДЖИ ДИ ЕМ ГРУП ≠ ГРУП 2019)", () => {
  const r = resolveClientFolder({ name: "ДЖИ ДИ ЕМ ГРУП", drive_folder_id: "1KTJpY5r9oYcGY0GSFEQpeIjTraq7dBWE" }, FIRMI_TOP);
  assertEquals(r, { id: "1KTJpY5r9oYcGY0GSFEQpeIjTraq7dBWE", name: "ДЖИ ДИ ЕМ ГРУП", source: "id" });
});

Deno.test("resolveClientFolder: ID-то намира папки, които името пропуска (Корект Преместване ЕООД, Петанои)", () => {
  // Без ID — по име не се намират:
  assertEquals(resolveClientFolder({ name: "Корект Преместване ЕООД", drive_folder_id: null }, FIRMI_TOP), null);
  assertEquals(resolveClientFolder({ name: "Петанои", drive_folder_id: null }, FIRMI_TOP), null);
  // С ID — намират се:
  const r = resolveClientFolder({ name: "Корект Преместване ЕООД", drive_folder_id: "1wS76AXZ01VhN1LBR1sU9Ngjfo_pGj1zg" }, FIRMI_TOP);
  assertEquals(r !== null && r !== "needsTopFolders" ? r.source : null, "id");
});

Deno.test("resolveClientFolder: празно drive_folder_id и още няма списък → иска списъка с папки", () => {
  assertEquals(resolveClientFolder({ name: "СКРИЙН БОКС ООД", drive_folder_id: null }, null), "needsTopFolders");
  assertEquals(resolveClientFolder({ name: "СКРИЙН БОКС ООД", drive_folder_id: "" }, null), "needsTopFolders");
  assertEquals(resolveClientFolder({ name: "СКРИЙН БОКС ООД" }, null), "needsTopFolders");
});

Deno.test("resolveClientFolder: празно drive_folder_id → резервно по име, с източник 'name'", () => {
  assertEquals(
    resolveClientFolder({ name: "Скрийн Бокс ООД", drive_folder_id: null }, FIRMI_TOP),
    { id: "folder_screen_boxx", name: "СКРИЙН БОКС ООД", source: "name" },
  );
});

Deno.test("resolveClientFolder: невалидно drive_folder_id → null, НЕ пада към името", () => {
  assertEquals(resolveClientFolder({ name: "СКРИЙН БОКС ООД", drive_folder_id: "x' or '1'='1" }, FIRMI_TOP), null);
  assertEquals(resolveClientFolder({ name: "СКРИЙН БОКС ООД", drive_folder_id: "short" }, null), null);
});

// ---------- isValidDriveFolderId() ----------

Deno.test("isValidDriveFolderId: реални ID-та от Firmi минават", () => {
  assert(isValidDriveFolderId("1--p_IUaWhqLZYeYo4nWTwhrIoZq3EnqN"));
  assert(isValidDriveFolderId("1_AHAKUSOxLqC8b8KfUmpnczhv_Z02skb"));
});

Deno.test("isValidDriveFolderId: кавички, интервали, URL и празно се отхвърлят", () => {
  assert(!isValidDriveFolderId("abc' in parents or '"));
  assert(!isValidDriveFolderId("https://drive.google.com/drive/folders/1sj4gMIT3Xq57uup3qjE6Guh6yUdheofv"));
  assert(!isValidDriveFolderId("1sj4gMIT3Xq 57uup3qj"));
  assert(!isValidDriveFolderId(""));
  assert(!isValidDriveFolderId(null));
  assert(!isValidDriveFolderId(undefined));
});