// Жива проверка на сигурността срещу production Supabase — САМО с
// публичния ключ (същия, който е в index.html), без никакви тайни.
// Целта: след всяка промяна да сме сигурни, че без вход нищо не се
// чете и не се пише. Пуска се и в CI (GitHub Actions).
//
// Пропуска се със SKIP_LIVE=1 (напр. без интернет).
// Пускане: deno test --allow-net --allow-env --allow-read supabase/tests/live_security.test.ts

import { assert, assertEquals } from "jsr:@std/assert";
import { fromFileUrl } from "jsr:@std/path@1";

const ROOT = fromFileUrl(new URL("../../", import.meta.url));
const SKIP = Deno.env.get("SKIP_LIVE") === "1";

async function publicConfig(): Promise<{ url: string; key: string }> {
  // Същите стойности, които всеки посетител вижда в index.html.
  const html = await Deno.readTextFile(ROOT + "index.html");
  const url = html.match(/const SUPABASE_URL = "([^"]+)"/)?.[1];
  const key = html.match(/const SUPABASE_ANON_KEY = "([^"]+)"/)?.[1];
  if (!url || !key) throw new Error("index.html: не намирам SUPABASE_URL / SUPABASE_ANON_KEY");
  return { url, key };
}

const T = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore: SKIP, fn });

// Мрежата към Supabase понякога зависва за секунди (TCP timeout) —
// един провален опит не е провал на сигурността. До 3 опита.
async function fetch(input: string, init?: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await globalThis.fetch(input, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

// Таблици, които НИКОГА не бива да се четат без вход.
const PRIVATE_TABLES = [
  "clients", "profiles", "tasks", "incoming_documents", "client_messages", "staff_messages",
  "client_reminders", "client_reminder_replies", "client_document_status", "automation_settings",
  "login_log", "audit_log", "attachments", "task_payments",
];

T("live: без вход нито една таблица с данни не връща редове", async () => {
  const { url, key } = await publicConfig();
  const leaks: string[] = [];
  for (const t of PRIVATE_TABLES) {
    const res = await fetch(`${url}/rest/v1/${t}?select=*&limit=1`, { headers: { apikey: key } });
    const body = await res.text();
    // RLS → 200 с [] ; липсващ grant → 401/403. И двете са ОК. Ред с данни — НЕ.
    if (res.ok && body.trim() !== "[]") leaks.push(`${t}: ${body.slice(0, 80)}`);
  }
  assertEquals(leaks, [], "изтичане без вход:\n" + leaks.join("\n"));
});

T("live: без вход не може да се пише (insert в clients → отказ)", async () => {
  const { url, key } = await publicConfig();
  const res = await fetch(`${url}/rest/v1/clients`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ name: "HYGIENE TEST — не трябва да се запише", type: "legal_entity", eik_egn: "100000099" }),
  });
  assert(!res.ok, `insert без вход мина със статус ${res.status}`);
});

T("live: rpc функциите не са достъпни с публичния ключ (0080)", async () => {
  const { url, key } = await publicConfig();
  for (const [fn, body] of [
    ["recompute_client_obligations", { p_client_id: "00000000-0000-0000-0000-000000000000" }],
    ["is_admin", {}],
    ["is_active", {}],
  ] as const) {
    const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert(res.status === 401 || res.status === 403 || res.status === 404, `${fn}: статус ${res.status}`);
  }
});

T("live: Storage bucket-ите не се листват без вход", async () => {
  const { url, key } = await publicConfig();
  for (const bucket of ["incoming", "attachments", "inspections"]) {
    const res = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: "", limit: 1 }),
    });
    const body = await res.text();
    assert(!res.ok || body.trim() === "[]", `${bucket}: ${res.status} ${body.slice(0, 80)}`);
  }
});

T("live: публичните функции отговарят на OPTIONS (CORS) и отказват без токен/тяло", async () => {
  const { url } = await publicConfig();
  for (const fn of ["upload---document", "client-messages", "reminder-confirm", "forward-to-controlisy"]) {
    const opt = await fetch(`${url}/functions/v1/${fn}`, { method: "OPTIONS" });
    await opt.text();
    assert(opt.ok, `${fn}: OPTIONS ${opt.status}`);
    const res = await fetch(`${url}/functions/v1/${fn}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    await res.text();
    assert(res.status >= 400, `${fn}: празно тяло мина със статус ${res.status}`);
  }
});

T("live: свободната регистрация е изключена (потребители се създават само от admin)", async () => {
  const { url, key } = await publicConfig();
  const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
  const s = await res.json();
  assertEquals(s.disable_signup, true, "Supabase → Authentication → Sign In / Providers → „Allow new users to sign up“ трябва да е изключено");
  assertEquals(s.external?.anonymous_users, false, "анонимни входове трябва да са изключени");
});

T("live: невалиден линк за качване не разкрива нищо", async () => {
  const { url } = await publicConfig();
  const res = await fetch(`${url}/functions/v1/upload---document`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "00000000-0000-0000-0000-000000000000" }),
  });
  const body = await res.json();
  assertEquals(res.status, 404);
  assert(!("client_name" in body), "върна име на клиент за фалшив токен");
});
