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
// Изисква secrets:
//   GOOGLE_SERVICE_ACCOUNT_KEY — цялото JSON съдържание на ключа
//   FIRMI_FOLDER_ID            — ID-то на root папката "Firmi" в Drive

import { createClient } from "npm:@supabase/supabase-js@2";

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
 * имената (засичането по име грешеше: "ДЖИ ДИ ЕМ ГРУП" хващаше
 * "ДЖИ ДИ ЕМ ГРУП 2019", а "Петанои" не намираше "ПЕНТАНОИ ЕООД").
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
 * реален файл (СКРИЙН БОКС ООД, 07.2026), не от документация —
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
        "id, period_label, client_id, stage_creation_done, clients ( name, eik_egn, drive_folder_id ), obligation_types ( code )",
      )
      .is("files_generated_detected_at", null)
      .eq("not_applicable", false)
      .neq("status", "completed");
    if (tasksErr) throw tasksErr;

    let checked = 0;
    let found = 0;
    let declarationsChecked = 0;
    let declarationsFound = 0;
    const skipped: string[] = [];
    const errors: string[] = [];
    const clientFolderCache = new Map<string, ClientFolder | null>();
    let topFolders: { id: string; name: string }[] | null = null; // папките под Firmi — само ако потрябват
    const nowIso = new Date().toISOString();

    for (const task of (tasks ?? []) as any[]) {
      try {
        const ym = parseYearMonth(task.period_label);
        if (!ym) continue; // тримесечни/годишни задължения — извън обхвата тук засега
        const code: string | undefined = (task.obligation_types as any)?.code;

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
        // дърво (наблюдавано на живо: СКРИЙН БОКС ООД/ДДС/07.2026/,
        // с DEKLAR.txt/POKUPKI.txt/PRODAGBI.txt — реалните ДДС експорти).
        if (!monthFolder) {
          const ddsFolder = await findChildFolder(accessToken, clientFolder.id, "ДДС");
          if (ddsFolder) {
            for (const candidate of candidateMonthFolderNames(ym.year, ym.month)) {
              const f = await findChildFolder(accessToken, ddsFolder.id, candidate);
              if (f) { monthFolder = f; pathPrefix = `${clientFolder.name}/${ddsFolder.name}`; break; }
            }
          }
        }
        if (!monthFolder) continue;

        const contents = await driveListChildren(accessToken, monthFolder.id);
        if (contents.length === 0) continue; // папката съществува, но е празна — все още нищо не е качено

        const path = `${pathPrefix}/${monthFolder.name}`;
        const updatePayload: Record<string, unknown> = {
          files_generated_detected_at: new Date().toISOString(),
          files_generated_detected_path: path,
        };

        // Best-effort сума на ДДС — само за задължението за ДДС, само
        // ако DEKLAR.txt е сред намерените файлове, и само ако мине
        // двойната самопроверка в parseDeklarVatAmount() (виж коментара
        // там — иначе не пишем нищо, по-добре липсващо от грешно число).
        if ((task.obligation_types as any)?.code === "vat_declaration") {
          const deklarFile = contents.find((f) => /deklar/i.test(f.name));
          if (deklarFile) {
            const fileRes = await fetch(
              `${DRIVE_FILES_URL}/${deklarFile.id}?alt=media`,
              { headers: { Authorization: `Bearer ${accessToken}` } },
            );
            if (fileRes.ok) {
              const buf = await fileRes.arrayBuffer();
              let text: string;
              try {
                text = new TextDecoder("windows-1251").decode(buf);
              } catch (_e) {
                text = new TextDecoder().decode(buf); // резервно, само цифрите ни трябват все пак
              }
              const vat = parseDeklarVatAmount(text);
              if (vat) {
                updatePayload.drive_detected_vat_amount = vat.amount;
                updatePayload.drive_detected_vat_direction = vat.direction;
              }
            }
          }
        }

        await supabase.from("tasks").update(updatePayload).eq("id", task.id);
        found++;
      } catch (e) {
        errors.push(`task ${task.id}: ${String(e)}`);
      }
    }

    await supabase.from("cron_heartbeats").insert({
      job_name: JOB_NAME,
      status: errors.length === 0 ? "ok" : "error",
      details: `checked=${checked} found=${found} decl_checked=${declarationsChecked} decl_found=${declarationsFound}` +
        ` skipped=${skipped.length} errors=${errors.length}` +
        (errors.length ? ` :: ${errors.slice(0, 5).join(" | ")}` : ""),
    });

    return new Response(JSON.stringify({
      ok: errors.length === 0, checked, found, declarationsChecked, declarationsFound, skipped, errors,
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
