// Органайзер — проверка за генерирани файлове в Google Drive (SPEC.md §10).
//
// САМО проверка за наличие + дата на последна промяна — НЕ чете
// съдържанието на файловете (SPEC.md §10, изрично решение).
// Различно от recognize-confirmation (там ЧЕТЕ съдържание на
// потвърждения, качени РЪЧНО през самия Органайзер) — тук просто
// маркира визуален чек-пойнт, че екипът вече е качил нещо в Firmi
// папката като част от обичайната месечна работа.
//
// Папковата структура НЕ е строго стандартизирана още (SPEC.md §10 —
// "да се съгласуват с Нерман и Емилия") — затова пробваме няколко
// разумни варианта на името на месечната папка, не само един твърд
// формат. Ако с времето се възприеме единен формат, candidateMonth-
// FolderNames() може да се стесни.
//
// Папката на фирмата се взима от clients.drive_folder_id (0073);
// засичане по име само ако полето е празно (виж resolveClientFolder).
//
// 2026-11-10: ДДС сумата — DEKLAR.txt се търси и в <фирма>/ДДС/ММ.ГГГГ/,
// когато месечната папка <фирма>/<ГГГГ>/<ММ…>/ съществува (с фактурите),
// но DEKLAR не е в нея. ДДС задачите, вече засечени без сума, се
// проверяват отново. Сумата се пише само ако ЕИК във файла = ЕИК на фирмата.
// Намерен DEKLAR на същата фирма слага и "Създадено" (с датата на файла).
// DEKLAR, създаден преди края на месеца, се пренебрегва (deklarCreatedAfterPeriod).
// v12 (2026-11-12): сумата се обновява, ако DEKLAR е генериран наново с друга
// сума — проверяват се всички ДДС задачи до ~60 дни назад, и подадените.
// v13 (2026-11-14): "Подаване" на ДДС от PDF-а на подадената справка-
// декларация от портала на НАП в месечната папка — входящият номер се
// записва в задачата (виж parseVatPortalPdf / buildVatSubmissionUpdate).
//
// Изисква secrets:
//   GOOGLE_SERVICE_ACCOUNT_KEY — цялото JSON съдържание на ключа
//   FIRMI_FOLDER_ID            — ID-то на root папката "Firmi" в Drive

import { createClient } from "npm:@supabase/supabase-js@2";
import { extractText, getDocumentProxy } from "npm:unpdf";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const JOB_NAME = "drive_file_check";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

// ---------------------------------------------------------------
// Автентикация със service account — РЪЧЕН JWT/RS256 подпис през
// вградения Web Crypto API на Deno, вместо "npm:google-auth-library".
// Причина: библиотеката (+ множеството ѝ под-зависимости — gaxios,
// gcp-metadata, gtoken, jws...) чупеше бъндъла на Supabase Edge
// Runtime с неясна грешка ("check is not defined" на ред 1 от
// компилирания файл — открито на живо при реален деплой). Ръчният
// подпис е малко повече код, но няма npm зависимости извън тези,
// които вече знаем, че работят в тази среда.
export function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function base64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getDriveAccessToken(clientEmail: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

// ---------------------------------------------------------------
// Чисти помощни функции (тествани в index.test.ts)
// ---------------------------------------------------------------

/** За сравнение на имена на папки срещу имена на клиенти — понижава
 * регистъра и свива множество интервали в един (реалната Firmi папка
 * има двойни интервали в някои имена, напр. "ПРЕМЕСТВАНЕ  ООД"). */
export function normalizeFolderName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** true = папка с това име може да се счита за същия клиент —
 * съвпада точно, или едното име съдържа другото (пази от "Корект"
 * срещу "Корект Опаковки" грешно съвпадение с твърде общо име,
 * доколкото практически имената на клиенти тук са достатъчно
 * специфични — виж коментар при companyNamesMatch в
 * recognize-confirmation за същия компромис). */
export function folderNameMatchesClient(folderName: string, clientName: string): boolean {
  const a = normalizeFolderName(folderName);
  const b = normalizeFolderName(clientName);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** ID на Drive папка — същото правило като CHECK-а на
 * clients.drive_folder_id (0073). Важно и за сигурността: ID-то влиза
 * в Drive заявка ("'<id>' in parents"), затова нищо друго не минава. */
export function isValidDriveFolderId(id: string | null | undefined): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{10,100}$/.test(id);
}

export type ClientFolder = { id: string; name: string; source: "id" | "name" };

/** Папката на фирмата в Firmi (0073, поискано изрично 2026-10-28):
 * ако clients.drive_folder_id е попълнено — САМО то, без да гледаме
 * имената (засичането по име грешеше: "ПРИМЕР ГРУП" хващаше
 * "ПРИМЕР ГРУП 2019", а "Примернои" не намираше "ПРИМЕРНОИ ЕООД").
 * Иначе — резервно по име измежду topFolders (папките директно под
 * Firmi). topFolders е null, докато не са изтеглени; връщаме
 * "needsTopFolders", за да не викаме Drive излишно, когато има ID.
 * Името в резултата е само за files_generated_detected_path. */
export function resolveClientFolder(
  client: { name: string; drive_folder_id?: string | null },
  topFolders: { id: string; name: string }[] | null,
): ClientFolder | null | "needsTopFolders" {
  if (client.drive_folder_id != null && client.drive_folder_id !== "") {
    // Попълнено, но невалидно ID не пада към името — по-добре нищо,
    // отколкото тихо да хванем чужда папка.
    return isValidDriveFolderId(client.drive_folder_id)
      ? { id: client.drive_folder_id, name: client.name, source: "id" }
      : null;
  }
  if (topFolders === null) return "needsTopFolders";
  const match = topFolders.find((f) => folderNameMatchesClient(f.name, client.name));
  return match ? { id: match.id, name: match.name, source: "name" } : null;
}

/** Кандидати за име на месечна папка под годишната — пробваме
 * няколко реални/предложени формата, не гадаем само един (виж
 * коментар най-горе за причината). */
export function candidateMonthFolderNames(year: number, month: number): string[] {
  const mm = String(month).padStart(2, "0");
  return [
    `${mm}.${year}`, // "06.2026" — наблюдавано на живо в реалната Firmi папка
    mm, // просто "06" под годишна папка
    `${year}-${mm}`,
    `${mm}-${year}`,
  ];
}

/** period_label е "YYYY-MM" (месечни/тримесечни са различни, тук ни
 * трябват само месечните за търсене в година/месец структурата) —
 * връща null, ако не е в този формат (напр. "2026-Q3", "2026"). */
export function parseYearMonth(periodLabel: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(periodLabel);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** Best-effort извличане на "ДДС за внасяне/възстановяване" от
 * суровия DEKLAR.txt (позиционен формат за подаване към НАП, БЕЗ
 * надписи на полетата — официалната спецификация не е налична тук).
 * Позициите на кл.20/40/50/60/71 по-долу са изведени ЕМПИРИЧНО от
 * реален файл (една фирма, 07.2026), не от документация —
 * затова НИКОГА не връщаме число, преди да са минали ДВЕ независими
 * аритметични проверки:
 *   1. кл.50 (или кл.60) трябва да съвпада с изчисленото кл.20−кл.40
 *   2. когато е "за внасяне", кл.71 (действително внесен) трябва да
 *      съвпада с кл.50 — различен, независимо позициониран запис
 * Ако която и да е проверка не излезе точно (до стотинка), връщаме
 * null — по-добре нищо, отколкото грешна сума с престорена сигурност. */
export function parseDeklarVatAmount(
  text: string,
): { amount: number; direction: "due" | "refund" } | null {
  const nums = [...text.matchAll(/-?\d+\.\d{2}/g)].map((m) => Number(m[0]));
  if (nums.length < 27) return null; // недостатъчно полета — форматът не съвпада с очаквания

  const kl20 = nums[1];
  const kl40 = nums[22];
  const kl50 = nums[23];
  const kl60 = nums[24];
  const kl71 = nums[26];
  const diff = Math.round((kl20 - kl40) * 100) / 100;

  if (diff > 0) {
    if (Math.abs(diff - kl50) > 0.01 || Math.abs(kl71 - kl50) > 0.01) return null;
    return { amount: kl50, direction: "due" };
  }
  if (diff < 0) {
    if (Math.abs(-diff - kl60) > 0.01) return null;
    return { amount: kl60, direction: "refund" };
  }
  return { amount: 0, direction: "due" }; // нулева декларация — и двете кл.50/кл.60 са 0
}

/** DEKLAR.txt започва с ДДС номера на фирмата ("BG206521026  ВИЖУАЛАЙЗ…").
 * Сумата се приема само ако това е същата фирма — пази от DEKLAR на
 * чужда фирма, копиран по грешка в папката. */
export function deklarMatchesEik(text: string, eik: string | null | undefined): boolean {
  if (!isValidEik(eik)) return false;
  const head = text.trimStart().slice(0, 20).toUpperCase().replace(/\s+/g, " ");
  const m = /^(?:BG)?(\d{9,13})\b/.exec(head);
  return !!m && m[1] === eik;
}

/** DEKLAR за месец M е валиден само ако е създаден след края на M
 * (Додо, 2026-11-10 — случай Албена Експрес: DEKLAR за 10.2026 от
 * 09.10.2026, т.е. без документите след 9-и). Граница: 00:00 ч. на 1-во
 * число на M+1 по българско време (UTC+3 лятно → взимаме −3 ч., за да не
 * отхвърлим файл, създаден в първите минути на месеца). Липсваща дата →
 * не приемаме (по-добре нищо, отколкото непълна декларация). */
export function deklarCreatedAfterPeriod(
  modifiedTime: string | undefined,
  ym: { year: number; month: number },
): boolean {
  const t = modifiedTime ? Date.parse(modifiedTime) : NaN;
  if (Number.isNaN(t)) return false;
  const periodEnd = Date.UTC(ym.year, ym.month, 1) - 3 * 3600 * 1000; // month е 1-12 → 1-во на следващия
  return t >= periodEnd;
}

// ---------------------------------------------------------------
// ДДС "Подаване" от PDF-а на портала на НАП (поискано изрично
// 2026-11-14, тест с една фирма + сверка с ръчно вписаните номера на
// 10.2026). След подаване счетоводителят записва от портала PDF на
// справка-декларацията (името е "portal.nra.bg_…ShowDocument….pdf" или
// преименувано, напр. "ДДСДневници ДеклVIES 2026.10.pdf") в месечната
// папка. Само в него има "Входящ номер"; разпечатката от Microinvest
// отпреди подаването е със същото заглавие, но полето е празно — тя
// просто не минава parseVatPortalPdf().
// ---------------------------------------------------------------

export type VatPortalDeclaration = {
  referenceNumber: string; // "22143699700"
  referenceDate: string; // "14.11.2026"
  vatEik: string; // без "BG"
  periodLabel: string; // "2026-10"
  vatDue: number | null; // кл. 50, само за сверка
};

/** Текстът на PDF-а → данните, или null, ако не е подадена справка-
 * декларация по ЗДДС (няма заглавие, входящ номер, ИН или период).
 * Работи и с подредбата на unpdf ("Входящ номер 22143699700 / 14.11.2026"
 * на един ред), и с етикет и стойност на отделни редове. */
export function parseVatPortalPdf(text: string): VatPortalDeclaration | null {
  if (!/СПРАВКА-ДЕКЛАРАЦИЯ ЗА ДАНЪК ВЪРХУ ДОБАВЕНАТА СТОЙНОСТ/i.test(text)) return null;
  const ref = /Входящ\s+номер\s*:?\s*([0-9A-Za-zА-Яа-я]{6,20})\s*\/\s*(\d{2})\.(\d{2})\.(\d{4})/.exec(text);
  const eik = /ИН\s+по\s+ЗДДС\s*:?\s*BG\s*(\d{9,13})\b/i.exec(text);
  const period = /Данъчен\s+период\s*:?\s*(\d{4})(\d{2})\b/.exec(text);
  if (!ref || !eik || !period) return null;
  const month = Number(period[2]);
  if (month < 1 || month > 12) return null;
  const due = /(\d+(?:\.\d+)?)\s+50\s+ДДС\s+за\s+възстановяване/.exec(text);
  return {
    referenceNumber: ref[1].toUpperCase(),
    referenceDate: `${ref[2]}.${ref[3]}.${ref[4]}`,
    vatEik: eik[1],
    periodLabel: `${period[1]}-${period[2]}`,
    vatDue: due ? Number(due[1]) : null,
  };
}

/** Само номерът, без дата и интервали — "22143699700/14.11.2026",
 * "22143699700 / 14.11.2026" и "22143699700" са едно и също. */
export function referenceKey(s: string): string {
  return s.split("/")[0].replace(/\s+/g, "").toUpperCase();
}

/** Какво се пише в ДДС задачата от намерения PDF. Нищо вписано на ръка
 * не се презаписва: друг номер → conflict (за skipped), без запис.
 * Отметката "Подаване" е с датата от входящия номер. Статусът и
 * "Прието" НЕ се пипат (както при ръчната отметка). */
export function buildVatSubmissionUpdate(
  task: { stage_submission_done?: boolean | null; submission_reference_number?: string | null },
  pdf: VatPortalDeclaration,
  nowIso: string,
): { update: Record<string, unknown> | null; conflict: string | null } {
  const reference = `${pdf.referenceNumber}/${pdf.referenceDate}`;
  const update: Record<string, unknown> = {};
  if (task.submission_reference_number) {
    if (referenceKey(task.submission_reference_number) !== referenceKey(reference)) {
      return { update: null, conflict: `вписан е ${task.submission_reference_number}, в PDF-а е ${reference}` };
    }
  } else {
    update.submission_reference_number = reference;
  }
  if (!task.stage_submission_done) {
    const [d, m, y] = pdf.referenceDate.split(".");
    const at = `${y}-${m}-${d}T10:00:00.000Z`; // ~обяд българско време; само датата се показва
    update.stage_submission_done = true;
    update.stage_submission_done_at = Date.parse(at) <= Date.parse(nowIso) ? at : nowIso;
  }
  return { update: Object.keys(update).length ? update : null, conflict: null };
}

/** PDF-ите в месечната папка се пробват в този ред (до VAT_PDF_LIMIT):
 * първо тези, чието име подсказва справката от портала, после най-новите. */
export const VAT_PDF_LIMIT = 8;
export function rankVatPdfCandidates(files: DriveFile[]): DriveFile[] {
  const score = (f: DriveFile) => (/showdocument|ivat|декл|ддс/i.test(f.name) ? 1 : 0);
  const time = (f: DriveFile) => {
    const t = f.modifiedTime ? Date.parse(f.modifiedTime) : NaN;
    return Number.isNaN(t) ? 0 : t;
  };
  return files
    .filter((f) => f.mimeType === "application/pdf")
    .sort((a, b) => score(b) - score(a) || time(b) - time(a))
    .slice(0, VAT_PDF_LIMIT);
}

// ---------------------------------------------------------------
// Декл. обр. 1 и обр. 6 — засичане по ИМЕТО на файла от Microinvest
// (поискано изрично 2026-10-20). Виж DECLARATIONS.md в тази папка.
//
// Microinvest ТРЗ генерира файлове за НАП с фиксиран формат на името:
//   Обр. 1 → EMPL2021_<ЕИК>_<ММ>.<ГГГГ>_<N>.TXT
//   Обр. 6 → NRA62007_<ЕИК>_<ММ>.<ГГГГ>_<N>.TXT
// На живо те са пръснати непоследователно — в месечната папка, в
// подпапка ТРЗ\, в "нови\", дори на ниво година, а месечната папка е
// ту "05", ту "05.2026". Затова НЕ обхождаме папки, а търсим по име в
// целия Drive: ЕИК + период в самото име са еднозначни — файл на
// друга фирма или за друг месец просто не съвпада, където и да лежи.
// ---------------------------------------------------------------

/** Кой вид задължение се засича по кой файл. Префиксът за търсене в
 * Drive е версията, която Microinvest пише днес; parseNapDeclaration-
 * FileName() приема и бъдеща версия (EMPLxxxx/NRA6xxxx), но Drive
 * търсенето е по точния префикс — при смяна на версията от
 * Microinvest, добави новия префикс тук. */
export const DECLARATION_FILES: Record<string, { kind: "obr1" | "obr6"; searchPrefixes: string[] }> = {
  obr1: { kind: "obr1", searchPrefixes: ["EMPL2021"] },
  obr6_monthly: { kind: "obr6", searchPrefixes: ["NRA62007"] },
};

/** Задължения, които НЕ бива да се маркират от общото правило "има
 * нещо в месечната папка" — то е твърде грубо за тях (фактура в
 * папката не значи, че декларацията е създадена; имейлът до клиента
 * изобщо не е файл в Drive). */
export const EXCLUDED_FROM_FOLDER_HEURISTIC = new Set(["obr1", "obr6_monthly", "contributions_email"]);

/** ЕИК (9 цифри), ЕИК на клон (13) или ЕГН (10) — само цифри. Важно и
 * за сигурността: стойността влиза в Drive заявка, затова НИЩО друго
 * освен цифри не се пуска нататък. */
export function isValidEik(eik: string | null | undefined): eik is string {
  return typeof eik === "string" && /^(\d{9}|\d{10}|\d{13})$/.test(eik);
}

export type NapDeclarationFile = { kind: "obr1" | "obr6"; eik: string; year: number; month: number };

/** Разпознава име на НАП файл от Microinvest. null = не е обр.1/обр.6
 * (напр. "Преглед на Декларация Обр. 6.pdf", "EMPL_backup.txt"). */
export function parseNapDeclarationFileName(name: string): NapDeclarationFile | null {
  const m = /^(EMPL|NRA6)\d{4}_(\d{9,13})_(\d{2})\.(\d{4})_\d+[^._]*\.txt$/i.exec(name.trim());
  if (!m) return null;
  const month = Number(m[3]);
  if (month < 1 || month > 12) return null;
  return {
    kind: m[1].toUpperCase() === "EMPL" ? "obr1" : "obr6",
    eik: m[2],
    month,
    year: Number(m[4]),
  };
}

/** Drive заявката за търсене на файла. Връща null при невалиден ЕИК
 * или период — по-добре никакво търсене, отколкото заявка с чужди
 * символи в нея. `name contains` в Drive е prefix-търсене, а нашият
 * низ е точно началото на името — затова съвпада. */
export function declarationSearchQuery(prefix: string, eik: string, year: number, month: number): string | null {
  if (!/^[A-Z0-9]+$/.test(prefix) || !isValidEik(eik)) return null;
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  const mm = String(month).padStart(2, "0");
  return `name contains '${prefix}_${eik}_${mm}.${year}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
}

export type DriveFile = { id: string; name: string; mimeType: string; modifiedTime?: string };

/** ЕСТИ справката (esti_monthly_report) се засича в подпапка ЕСТИ на
 * месечната папка (напр. Фирма/2026/10.2026/ЕСТИ/). Имената са
 * кирилица или латиница — така ги пишат счетоводителите. */
export const ESTI_FOLDER_NAMES = ["ЕСТИ", "ESTI"];

/** Справката за месец M се проверява от 1-во число на M+1 (тогава
 * се генерира). Преди това папката е празна и проверката е излишна. */
export function estiCheckAllowed(ym: { year: number; month: number }, now: Date): boolean {
  const start = Date.UTC(ym.year, ym.month, 1); // month е 1-12 → Date.UTC(…, month) е 1-во на следващия
  return now.getTime() >= start;
}

/** Първият (най-ранно променен) файл — не папка — в ЕСТИ папката.
 * Null, ако е празна или има само подпапки. */
export function pickEstiFile(files: DriveFile[]): DriveFile | null {
  const only = files.filter((f) => f.mimeType !== "application/vnd.google-apps.folder");
  if (only.length === 0) return null;
  const time = (f: DriveFile) => {
    const t = f.modifiedTime ? Date.parse(f.modifiedTime) : NaN;
    return Number.isNaN(t) ? Infinity : t;
  };
  return [...only].sort((a, b) => time(a) - time(b))[0];
}

/** ЕСТИ: справката се сваля от системата на ЕСТИ СЛЕД като е подадена
 * (потвърдено от потребителя 06.11.2026: „вече е и подадена, след като
 * е създадена и я има във файла“). Затова файлът в подпапката ЕСТИ
 * отмята и трите стъпки — Създаване, Проверка, Подаване — с датата на
 * файла. Ръчно сложена отметка не се пипа (пази се нейната дата).
 * Статусът на задачата не се променя (както при ръчното отмятане). */
export function buildEstiUpdate(
  task: { stage_creation_done?: boolean | null; stage_review_done?: boolean | null; stage_submission_done?: boolean | null },
  file: DriveFile,
  nowIso: string,
): Record<string, unknown> {
  const payload = buildDeclarationUpdate(task, file, nowIso);
  const t = file.modifiedTime ? Date.parse(file.modifiedTime) : NaN;
  const at = !Number.isNaN(t) && t <= Date.parse(nowIso) ? new Date(t).toISOString() : nowIso;
  if (!task.stage_review_done) {
    payload.stage_review_done = true;
    payload.stage_review_done_at = at;
  }
  if (!task.stage_submission_done) {
    payload.stage_submission_done = true;
    payload.stage_submission_done_at = at;
  }
  return payload;
}

/** От резултатите на търсенето избира файла, който ТОЧНО отговаря на
 * задачата (вид + ЕИК + месец + година) — Drive "contains" може да
 * върне и повече, напр. ЕИК, който е префикс на 13-цифрен ЕИК на клон.
 * При няколко копия (корекции "_5", копие в "нови\") — най-ранното,
 * т.е. кога декларацията е създадена за първи път. */
export function pickDeclarationFile(
  files: DriveFile[],
  want: NapDeclarationFile,
): DriveFile | null {
  const matching = files.filter((f) => {
    if (f.mimeType === "application/vnd.google-apps.folder") return false;
    const p = parseNapDeclarationFileName(f.name);
    return !!p && p.kind === want.kind && p.eik === want.eik && p.year === want.year && p.month === want.month;
  });
  if (matching.length === 0) return null;
  const time = (f: DriveFile) => {
    const t = f.modifiedTime ? Date.parse(f.modifiedTime) : NaN;
    return Number.isNaN(t) ? Infinity : t;
  };
  return [...matching].sort((a, b) => time(a) - time(b))[0];
}

/** Какво пишем в задачата при намерен файл. Отметката "Създаване" се
 * слага само ако още не е сложена — ръчно отметната от счетоводителя
 * остава с нейната дата. Статусът на задачата НЕ се пипа (както и
 * ръчната отметка в таблото не го пипа). */
export function buildDeclarationUpdate(
  task: { stage_creation_done?: boolean | null },
  file: DriveFile,
  nowIso: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    files_generated_detected_at: nowIso,
    files_generated_detected_path: file.name,
  };
  if (!task.stage_creation_done) {
    const t = file.modifiedTime ? Date.parse(file.modifiedTime) : NaN;
    // Дата в бъдещето (разминат часовник на сървъра) или липсваща → днес.
    const at = !Number.isNaN(t) && t <= Date.parse(nowIso) ? new Date(t).toISOString() : nowIso;
    payload.stage_creation_done = true;
    payload.stage_creation_done_at = at;
  }
  return payload;
}

// ---------------------------------------------------------------
// Drive API — тънка обвивка (не се тества директно, само чрез
// чистите функции по-горе; мрежовите извиквания са интеграционни).
// ---------------------------------------------------------------

async function driveListChildren(
  accessToken: string,
  parentId: string,
  extra = "",
): Promise<{ id: string; name: string; mimeType: string; modifiedTime?: string }[]> {
  const q = `'${parentId}' in parents and trashed = false${extra}`;
  const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=${
    encodeURIComponent("files(id,name,mimeType,modifiedTime)")
  }&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Drive list failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.files ?? [];
}

async function driveSearch(accessToken: string, q: string): Promise<DriveFile[]> {
  const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=${
    encodeURIComponent("files(id,name,mimeType,modifiedTime)")
  }&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Drive search failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.files ?? [];
}

async function findChildFolder(accessToken: string, parentId: string, name: string) {
  const escaped = name.replace(/'/g, "\\'");
  const children = await driveListChildren(
    accessToken,
    parentId,
    ` and mimeType = 'application/vnd.google-apps.folder' and name = '${escaped}'`,
  );
  return children[0] ?? null;
}

/** <фирма>/ДДС/<ММ.ГГГГ или друг кандидат>/ — отделната ДДС папка. */
async function findDdsMonthFolder(
  accessToken: string,
  clientFolderId: string,
  ym: { year: number; month: number },
): Promise<{ dds: { id: string; name: string }; month: { id: string; name: string } } | null> {
  const dds = await findChildFolder(accessToken, clientFolderId, "ДДС");
  if (!dds) return null;
  for (const candidate of candidateMonthFolderNames(ym.year, ym.month)) {
    const f = await findChildFolder(accessToken, dds.id, candidate);
    if (f) return { dds, month: f };
  }
  return null;
}

async function downloadText1251(accessToken: string, fileId: string): Promise<string | null> {
  const fileRes = await fetch(`${DRIVE_FILES_URL}/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!fileRes.ok) return null;
  const buf = await fileRes.arrayBuffer();
  try {
    return new TextDecoder("windows-1251").decode(buf);
  } catch (_e) {
    return new TextDecoder().decode(buf); // резервно, само цифрите ни трябват все пак
  }
}

/** Подадената ДДС справка (PDF от портала) за фирмата и месеца. Гледа в
 * <фирма>/ДДС/<месец>/, <фирма>/<ГГГГ>/<месец>/ и в подпапка "ДДС" на
 * всяка от тях (на живо са и трите — 14.11.2026). Приема само PDF с ИН
 * по ЗДДС = BG+ЕИК на фирмата и период = периода на задачата. */
async function findVatPortalPdf(
  accessToken: string,
  clientFolderId: string,
  ym: { year: number; month: number },
  eik: string,
): Promise<{ pdf: VatPortalDeclaration; file: DriveFile } | null> {
  const monthFolders: { id: string }[] = [];
  const dds = await findDdsMonthFolder(accessToken, clientFolderId, ym);
  if (dds) monthFolders.push(dds.month);
  const yearFolder = await findChildFolder(accessToken, clientFolderId, String(ym.year));
  if (yearFolder) {
    for (const candidate of candidateMonthFolderNames(ym.year, ym.month)) {
      const f = await findChildFolder(accessToken, yearFolder.id, candidate);
      if (f) { monthFolders.push(f); break; }
    }
  }
  const folders = [...monthFolders];
  for (const mf of monthFolders) {
    const sub = await findChildFolder(accessToken, mf.id, "ДДС");
    if (sub) folders.push(sub);
  }
  const pdfs: DriveFile[] = [];
  for (const f of folders) {
    pdfs.push(...await driveListChildren(accessToken, f.id, " and mimeType = 'application/pdf'"));
  }
  const want = `${ym.year}-${String(ym.month).padStart(2, "0")}`;
  for (const file of rankVatPdfCandidates(pdfs)) {
    const res = await fetch(`${DRIVE_FILES_URL}/${file.id}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) continue;
    try {
      const doc = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
      const { text } = await extractText(doc, { mergePages: true });
      const pdf = parseVatPortalPdf(text);
      if (pdf && pdf.vatEik === eik && pdf.periodLabel === want) return { pdf, file };
    } catch (_e) {
      // повреден/сканиран PDF — следващият
    }
  }
  return null;
}

// import.meta.main е true само когато Deno изпълнява ТОЗИ файл пряко
// (production) — не и когато тестов файл го импортира само за да
// ползва export-натите чисти функции по-горе.
if (import.meta.main) {
  Deno.serve(handler);
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const firmiFolderId = Deno.env.get("FIRMI_FOLDER_ID")!;
    const saKey = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY")!);
    const accessToken = await getDriveAccessToken(saKey.client_email, saKey.private_key);

    // Само задачи, които още НЕ са маркирани (веднъж открит файл, не
    // го проверяваме пак всеки път — намалява Drive извикванията) и
    // не са завършени/неприложими.
    const { data: tasks, error: tasksErr } = await supabase
      .from("tasks")
      .select(
        "id, period_label, client_id, stage_creation_done, stage_review_done, stage_submission_done, clients ( name, eik_egn, drive_folder_id ), obligation_types ( code )",
      )
      .is("files_generated_detected_at", null)
      .eq("not_applicable", false)
      .neq("status", "completed");
    if (tasksErr) throw tasksErr;

    // ЕСТИ задачи, засечени по стария груб метод (папката не е празна), но
    // още без отметка "Подаване" — проверяваме ги пак в подпапка ЕСТИ.
    const { data: estiTasks, error: estiTasksErr } = await supabase
      .from("tasks")
      .select(
        "id, period_label, client_id, stage_creation_done, stage_review_done, stage_submission_done, clients ( name, eik_egn, drive_folder_id ), obligation_types!inner ( code )",
      )
      .not("files_generated_detected_at", "is", null)
      .eq("stage_submission_done", false)
      .eq("not_applicable", false)
      .neq("status", "completed")
      .eq("obligation_types.code", "esti_monthly_report");
    if (estiTasksErr) throw estiTasksErr;

    // ДДС задачи, засечени по месечната папка (с фактурите), но още без
    // сума — DEKLAR.txt често е в отделната <фирма>/ДДС/ММ.ГГГГ/ (2026-11-10).
    // При тях пишем само сумата и пътя до DEKLAR; датата на засичане остава.
    // v12 (2026-11-12): проверяват се ВСИЧКИ ДДС задачи от последните ~60 дни
    // (и подадените), не само тези без сума — DEKLAR често се генерира наново
    // след първото засичане и сумата в Органайзера оставаше стара.
    // Сумата се презаписва само ако е различна.
    const vatSince = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const { data: vatTasks, error: vatTasksErr } = await supabase
      .from("tasks")
      .select(
        "id, period_label, client_id, stage_creation_done, stage_review_done, stage_submission_done, drive_detected_vat_amount, drive_detected_vat_direction, clients ( name, eik_egn, drive_folder_id ), obligation_types!inner ( code )",
      )
      .not("files_generated_detected_at", "is", null)
      .eq("not_applicable", false)
      .gte("period_end", vatSince)
      .eq("obligation_types.code", "vat_declaration");
    if (vatTasksErr) throw vatTasksErr;

    // v13: ДДС задачи без "Подаване" или без номер — търсим PDF-а от
    // портала (виж findVatPortalPdf). Само последните ~60 дни.
    const { data: vatSubmitTasks, error: vatSubmitErr } = await supabase
      .from("tasks")
      .select(
        "id, period_label, client_id, stage_submission_done, submission_reference_number, drive_detected_vat_amount, clients ( name, eik_egn, drive_folder_id ), obligation_types!inner ( code )",
      )
      .eq("not_applicable", false)
      .neq("status", "completed")
      .gte("period_end", vatSince)
      .eq("obligation_types.code", "vat_declaration")
      .or("stage_submission_done.eq.false,submission_reference_number.is.null");
    if (vatSubmitErr) throw vatSubmitErr;

    const seenIds = new Set((tasks ?? []).map((t: any) => t.id));
    const allTasks: any[] = [...(tasks ?? [])];
    for (const t of [...(estiTasks ?? []), ...(vatTasks ?? [])] as any[]) {
      if (seenIds.has(t.id)) continue;
      seenIds.add(t.id);
      allTasks.push(t);
    }
    const vatRecheckIds = new Set((vatTasks ?? []).map((t: any) => t.id));
    for (const t of tasks ?? []) vatRecheckIds.delete((t as any).id);

    let checked = 0;
    let found = 0;
    let declarationsChecked = 0;
    let declarationsFound = 0;
    let vatAmountsFound = 0;
    let creationsMarked = 0;
    const skipped: string[] = [];
    const errors: string[] = [];
    const clientFolderCache = new Map<string, ClientFolder | null>();
    let topFolders: { id: string; name: string }[] | null = null; // папките под Firmi — само ако потрябват
    const nowIso = new Date().toISOString();
    const startedAt = Date.now();

    for (const task of allTasks as any[]) {
      try {
        const ym = parseYearMonth(task.period_label);
        if (!ym) continue; // тримесечни/годишни задължения — извън обхвата тук засега
        const code: string | undefined = (task.obligation_types as any)?.code;
        const isVat = code === "vat_declaration";
        const vatRecheck = vatRecheckIds.has(task.id);

        // Декл. обр. 1 / обр. 6 — по името на файла, не по папки.
        const decl = code ? DECLARATION_FILES[code] : undefined;
        if (decl) {
          const eik: string | undefined = task.clients?.eik_egn;
          if (!isValidEik(eik)) {
            skipped.push(`task ${task.id}: невалиден ЕИК "${eik ?? ""}"`);
            continue;
          }
          declarationsChecked++;
          const results: DriveFile[] = [];
          for (const prefix of decl.searchPrefixes) {
            const q = declarationSearchQuery(prefix, eik, ym.year, ym.month);
            if (q) results.push(...await driveSearch(accessToken, q));
          }
          const file = pickDeclarationFile(results, { kind: decl.kind, eik, year: ym.year, month: ym.month });
          if (!file) continue; // още не е генерирана — пак при следващото пускане
          const { error: updErr } = await supabase.from("tasks").update(buildDeclarationUpdate(task, file, nowIso)).eq("id", task.id);
          if (updErr) throw updErr;
          declarationsFound++;
          continue;
        }
        if (code && EXCLUDED_FROM_FOLDER_HEURISTIC.has(code)) continue;

        const clientName: string | undefined = task.clients?.name;
        if (!clientName) continue;
        checked++;

        // Клиентска папка — кеширана в рамките на това изпълнение, за
        // да не питаме Drive повторно за всяка задача на същия клиент.
        const client = { name: clientName, drive_folder_id: task.clients?.drive_folder_id as string | null };
        const cacheKey: string = task.client_id ?? clientName;
        let clientFolder = clientFolderCache.get(cacheKey);
        if (clientFolder === undefined) {
          let resolved = resolveClientFolder(client, topFolders);
          if (resolved === "needsTopFolders") {
            topFolders = await driveListChildren(
              accessToken,
              firmiFolderId,
              " and mimeType = 'application/vnd.google-apps.folder'",
            );
            resolved = resolveClientFolder(client, topFolders);
          }
          clientFolder = resolved === "needsTopFolders" ? null : resolved;
          clientFolderCache.set(cacheKey, clientFolder);
          if (client.drive_folder_id && !clientFolder) {
            skipped.push(`клиент "${clientName}": невалиден drive_folder_id "${client.drive_folder_id}"`);
          } else if (!client.drive_folder_id) {
            // По веднъж на клиент — сигнал да се попълни drive_folder_id.
            skipped.push(
              `клиент "${clientName}": няма drive_folder_id — засичане по име` +
                (clientFolder ? ` → "${clientFolder.name}"` : " → няма съвпадение"),
            );
          }
        }
        if (!clientFolder) continue; // няма папка за този клиент — нищо за проверка

        // Основен път: [Фирма]/[Година]/[ММ или ММ.Година]/ — общата
        // месечна структура (наблюдавана на живо за повечето видове).
        let monthFolder: { id: string; name: string } | null = null;
        let pathPrefix: string | null = null;
        const yearFolder = await findChildFolder(accessToken, clientFolder.id, String(ym.year));
        if (yearFolder) {
          for (const candidate of candidateMonthFolderNames(ym.year, ym.month)) {
            const f = await findChildFolder(accessToken, yearFolder.id, candidate);
            if (f) { monthFolder = f; pathPrefix = `${clientFolder.name}/${yearFolder.name}`; break; }
          }
        }

        // Резервен път: [Фирма]/ДДС/[ММ.Година]/ — ДДС има собствена
        // папка на ниво фирма при някои клиенти, отделно от годишното
        // дърво (наблюдавано на живо: <фирма>/ДДС/07.2026/,
        // с DEKLAR.txt/POKUPKI.txt/PRODAGBI.txt — реалните ДДС експорти).
        let ddsMonth: { dds: { id: string; name: string }; month: { id: string; name: string } } | null = null;
        if (!monthFolder) {
          ddsMonth = await findDdsMonthFolder(accessToken, clientFolder.id, ym);
          if (ddsMonth) { monthFolder = ddsMonth.month; pathPrefix = `${clientFolder.name}/${ddsMonth.dds.name}`; }
        }
        if (!monthFolder) continue;

        // ЕСТИ: само подпапка ЕСТИ/ESTI, само от 1-во число на следващия
        // месец; файлът се сваля след подаване → и трите отметки
        // (виж buildEstiUpdate).
        if (code === "esti_monthly_report") {
          if (!estiCheckAllowed(ym, new Date(nowIso))) continue;
          let estiFolder: { id: string; name: string } | null = null;
          for (const n of ESTI_FOLDER_NAMES) {
            estiFolder = await findChildFolder(accessToken, monthFolder.id, n);
            if (estiFolder) break;
          }
          if (!estiFolder) continue; // папката още не е създадена от счетоводителя
          const estiFile = pickEstiFile(await driveListChildren(accessToken, estiFolder.id));
          if (!estiFile) continue;
          const payload = buildEstiUpdate(task, estiFile, nowIso);
          payload.files_generated_detected_path = `${pathPrefix}/${monthFolder.name}/${estiFolder.name}/${estiFile.name}`;
          const { error: estiErr } = await supabase.from("tasks").update(payload).eq("id", task.id);
          if (estiErr) throw estiErr;
          found++;
          continue;
        }

        const contents = await driveListChildren(accessToken, monthFolder.id);
        const path = `${pathPrefix}/${monthFolder.name}`;

        // Best-effort сума на ДДС — само за задължението за ДДС, само
        // ако е намерен DEKLAR.txt на същата фирма, и само ако мине
        // двойната самопроверка в parseDeklarVatAmount() (виж коментара
        // там — иначе не пишем нищо, по-добре липсващо от грешно число).
        // DEKLAR се търси в месечната папка, а ако го няма там — в
        // <фирма>/ДДС/<ММ.ГГГГ>/ (2026-11-10).
        let vat: { amount: number; direction: "due" | "refund" } | null = null;
        let deklarPath: string | null = null;
        let deklarOwn: DriveFile | null = null; // DEKLAR на същата фирма → "Създадено"
        if (isVat) {
          let deklarFile: DriveFile | null = contents.find((f) => /deklar/i.test(f.name)) ?? null;
          if (deklarFile) deklarPath = `${path}/${deklarFile.name}`;
          if (!deklarFile && !ddsMonth) {
            const alt = await findDdsMonthFolder(accessToken, clientFolder.id, ym);
            if (alt) {
              const altContents = await driveListChildren(accessToken, alt.month.id);
              deklarFile = altContents.find((f) => /deklar/i.test(f.name)) ?? null;
              if (deklarFile) deklarPath = `${clientFolder.name}/${alt.dds.name}/${alt.month.name}/${deklarFile.name}`;
            }
          }
          if (deklarFile && !deklarCreatedAfterPeriod(deklarFile.modifiedTime, ym)) {
            skipped.push(
              `task ${task.id}: ${deklarPath} е създаден ${deklarFile.modifiedTime ?? "(без дата)"} — преди края на периода; не се отбелязва`,
            );
            deklarFile = null;
          }
          if (deklarFile) {
            const text = await downloadText1251(accessToken, deklarFile.id);
            if (text) {
              if (deklarMatchesEik(text, task.clients?.eik_egn)) {
                deklarOwn = deklarFile;
                vat = parseDeklarVatAmount(text);
              } else {
                skipped.push(`task ${task.id}: ЕИК в ${deklarPath} не съвпада с фирмата — сумата не е записана`);
              }
            }
          }
        }

        // "Създадено" за ДДС (Додо, 2026-11-10): щом DEKLAR.txt на същата фирма
        // е в папката, декларацията е създадена — отметката с датата на файла.
        // Ръчно сложена отметка остава с нейната дата; "Потвърдено от клиента"
        // и "Проверено" НЕ се пипат.
        const creationFields = (): Record<string, unknown> => {
          if (!deklarOwn || task.stage_creation_done) return {};
          const t = deklarOwn.modifiedTime ? Date.parse(deklarOwn.modifiedTime) : NaN;
          const at = !Number.isNaN(t) && t <= Date.parse(nowIso) ? new Date(t).toISOString() : nowIso;
          return { stage_creation_done: true, stage_creation_done_at: at };
        };

        // Повторна проверка на вече засечена ДДС задача: пишем само сумата,
        // отметката "Създадено" и пътя до DEKLAR — нищо друго.
        if (vatRecheck) {
          const payload: Record<string, unknown> = { ...creationFields() };
          const oldAmount = task.drive_detected_vat_amount == null ? null : Number(task.drive_detected_vat_amount);
          if (vat && (oldAmount === null || Math.abs(oldAmount - vat.amount) > 0.004 || task.drive_detected_vat_direction !== vat.direction)) {
            payload.drive_detected_vat_amount = vat.amount;
            payload.drive_detected_vat_direction = vat.direction;
          } else {
            vat = null; // без промяна — не броим и не пишем
          }
          if (Object.keys(payload).length === 0) continue;
          if (deklarPath) payload.files_generated_detected_path = deklarPath;
          const { error: vErr } = await supabase.from("tasks").update(payload).eq("id", task.id);
          if (vErr) throw vErr;
          if (vat) vatAmountsFound++;
          if (payload.stage_creation_done) creationsMarked++;
          continue;
        }

        if (contents.length === 0 && !deklarPath) continue; // папката съществува, но е празна — все още нищо не е качено

        const updatePayload: Record<string, unknown> = {
          files_generated_detected_at: new Date().toISOString(),
          files_generated_detected_path: deklarPath ?? path,
          ...creationFields(),
        };
        if (updatePayload.stage_creation_done) creationsMarked++;
        if (vat) {
          updatePayload.drive_detected_vat_amount = vat.amount;
          updatePayload.drive_detected_vat_direction = vat.direction;
          vatAmountsFound++;
        }

        await supabase.from("tasks").update(updatePayload).eq("id", task.id);
        found++;
      } catch (e) {
        errors.push(`task ${task.id}: ${String(e)}`);
      }
    }

    // v13: ДДС "Подаване" + входящ номер от PDF-а на портала.
    let vatSubmissionsMarked = 0;
    for (const task of (vatSubmitTasks ?? []) as any[]) {
      // cron-ът чака до 150 с; PDF-ите се свалят и четат — останалите
      // задачи остават за следващото пускане (след 2 ч.).
      if (Date.now() - startedAt > 100_000) {
        skipped.push("vat-submit: спряно по време, останалите — при следващото пускане");
        break;
      }
      try {
        const ym = parseYearMonth(task.period_label);
        const eik: string | undefined = task.clients?.eik_egn;
        if (!ym || !isValidEik(eik)) continue;
        const client = { name: task.clients?.name ?? "", drive_folder_id: task.clients?.drive_folder_id as string | null };
        const cacheKey: string = task.client_id ?? client.name;
        let clientFolder = clientFolderCache.get(cacheKey);
        if (clientFolder === undefined) {
          let resolved = resolveClientFolder(client, topFolders);
          if (resolved === "needsTopFolders") {
            topFolders = await driveListChildren(accessToken, firmiFolderId, " and mimeType = 'application/vnd.google-apps.folder'");
            resolved = resolveClientFolder(client, topFolders);
          }
          clientFolder = resolved === "needsTopFolders" ? null : resolved;
          clientFolderCache.set(cacheKey, clientFolder);
        }
        if (!clientFolder) continue;

        const hit = await findVatPortalPdf(accessToken, clientFolder.id, ym, eik);
        if (!hit) continue; // още не е подадена/качена — пак при следващото пускане
        const { update, conflict } = buildVatSubmissionUpdate(task, hit.pdf, nowIso);
        if (conflict) {
          skipped.push(`task ${task.id} (${client.name} ${task.period_label}): ${conflict} — не е презаписано`);
          continue;
        }
        if (!update) continue;
        const { error: sErr } = await supabase.from("tasks").update(update).eq("id", task.id);
        if (sErr) throw sErr;
        await supabase.from("audit_log").insert({
          entity_type: "task",
          entity_id: task.id,
          action: "stage_changed",
          details: { field: "stage_submission_done", value: true, source: "swift-worker: PDF от портала на НАП", file: hit.file.name, ...update },
        });
        const known = task.drive_detected_vat_amount == null ? null : Number(task.drive_detected_vat_amount);
        if (known !== null && hit.pdf.vatDue !== null && Math.abs(known - hit.pdf.vatDue) > 0.004) {
          skipped.push(`task ${task.id} (${client.name} ${task.period_label}): ДДС в подадената справка ${hit.pdf.vatDue}, в DEKLAR.txt ${known}`);
        }
        vatSubmissionsMarked++;
      } catch (e) {
        errors.push(`vat-submit ${task.id}: ${String(e)}`);
      }
    }

    await supabase.from("cron_heartbeats").insert({
      job_name: JOB_NAME,
      status: errors.length === 0 ? "ok" : "error",
      details: `checked=${checked} found=${found} decl_checked=${declarationsChecked} decl_found=${declarationsFound}` +
        ` vat_amounts=${vatAmountsFound} vat_created=${creationsMarked} vat_submitted=${vatSubmissionsMarked}` +
        ` skipped=${skipped.length} errors=${errors.length}` +
        (errors.length ? ` :: ${errors.slice(0, 5).join(" | ")}` : ""),
    });

    return new Response(JSON.stringify({
      ok: errors.length === 0, checked, found, declarationsChecked, declarationsFound, vatAmountsFound, creationsMarked,
      vatSubmissionsMarked, skipped, errors,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    try {
      await supabase.from("cron_heartbeats").insert({ job_name: JOB_NAME, status: "error", details: String(e) });
    } catch (_ignored) {
      // тишината на монитора е сигналът, ако дори heartbeat записът падне
    }
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
