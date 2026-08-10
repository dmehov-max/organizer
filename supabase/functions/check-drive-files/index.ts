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
      .select("id, period_label, client_id, clients ( name )")
      .is("files_generated_detected_at", null)
      .eq("not_applicable", false)
      .neq("status", "completed");
    if (tasksErr) throw tasksErr;

    let checked = 0;
    let found = 0;
    const errors: string[] = [];
    const clientFolderCache = new Map<string, { id: string; name: string } | null>();

    for (const task of (tasks ?? []) as any[]) {
      try {
        const ym = parseYearMonth(task.period_label);
        if (!ym) continue; // тримесечни/годишни задължения — извън обхвата тук засега
        const clientName: string | undefined = task.clients?.name;
        if (!clientName) continue;
        checked++;

        // Клиентска папка — кеширана в рамките на това изпълнение, за
        // да не питаме Drive повторно за всяка задача на същия клиент.
        let clientFolder = clientFolderCache.get(clientName);
        if (clientFolder === undefined) {
          const topFolders = await driveListChildren(
            accessToken,
            firmiFolderId,
            " and mimeType = 'application/vnd.google-apps.folder'",
          );
          const match = topFolders.find((f) => folderNameMatchesClient(f.name, clientName));
          clientFolder = match ? { id: match.id, name: match.name } : null;
          clientFolderCache.set(clientName, clientFolder);
        }
        if (!clientFolder) continue; // няма папка с това име в Firmi — нищо за проверка

        const yearFolder = await findChildFolder(accessToken, clientFolder.id, String(ym.year));
        if (!yearFolder) continue;

        let monthFolder: { id: string; name: string } | null = null;
        for (const candidate of candidateMonthFolderNames(ym.year, ym.month)) {
          const f = await findChildFolder(accessToken, yearFolder.id, candidate);
          if (f) { monthFolder = f; break; }
        }
        if (!monthFolder) continue;

        const contents = await driveListChildren(accessToken, monthFolder.id);
        if (contents.length === 0) continue; // папката съществува, но е празна — все още нищо не е качено

        const path = `${clientFolder.name}/${yearFolder.name}/${monthFolder.name}`;
        await supabase.from("tasks").update({
          files_generated_detected_at: new Date().toISOString(),
          files_generated_detected_path: path,
        }).eq("id", task.id);
        found++;
      } catch (e) {
        errors.push(`task ${task.id}: ${String(e)}`);
      }
    }

    await supabase.from("cron_heartbeats").insert({
      job_name: JOB_NAME,
      status: errors.length === 0 ? "ok" : "error",
      details: `checked=${checked} found=${found} errors=${errors.length}` +
        (errors.length ? ` :: ${errors.slice(0, 5).join(" | ")}` : ""),
    });

    return new Response(JSON.stringify({ ok: errors.length === 0, checked, found, errors }), {
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
