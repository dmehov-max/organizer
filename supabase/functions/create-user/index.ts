// Органайзер — admin добавя нов потребител (счетоводител/admin)
// директно от приложението, вместо ръчно през Supabase Auth таблото.
//
// Защо Edge Function, не директно от браузъра: създаването на Auth
// потребител изисква service_role — да се сложи този ключ в
// index.html би дало на всеки логнат потребител пълен байпас на RLS
// (виж бележката в .env "ВНИМАНИЕ: service_role заобикаля цялото
// RLS"). Затова само тук, сървърно, след проверка че викащият Е admin.
//
// НЕ праща покана-имейл (inviteUserByEmail) — тя логва човека веднага
// БЕЗ да го кара да си сложи парола (виж реалния случай с
// neriinka777@gmail.com, 2026-08-17/18: остана без парола, после и
// AAL2 проблем при recovery). Вместо това: генерира временна парола
// тук и я връща в отговора — admin я предава директно на новия
// потребител (същия работещ модел, използван ръчно преди това).

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function generateTempPassword(): string {
  // Четимо-случаен низ, не чист UUID — по-лесно за диктуване/преписване
  // на глас, ако се налага. Достатъчно ентропия за временна парола,
  // която и без друго очакваме да се смени скоро.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

if (import.meta.main) {
  Deno.serve(handler);
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Липсва Authorization header" }), { status: 401, headers: corsHeaders });
    }

    // Скопиран с JWT-то на викащия — проверяваме РЕАЛНО дали е admin,
    // не се доверяваме на нищо изпратено от клиента за това.
    const scoped = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await scoped.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Невалидна сесия" }), { status: 401, headers: corsHeaders });
    }
    const { data: callerProfile } = await scoped.from("profiles").select("role").eq("id", user.id).single();
    if (callerProfile?.role !== "admin") {
      return new Response(JSON.stringify({ error: "Само admin може да добавя потребители" }), { status: 403, headers: corsHeaders });
    }

    const { email, full_name, role } = await req.json();
    if (!email || !full_name || !["admin", "accountant"].includes(role)) {
      return new Response(JSON.stringify({ error: "Липсват задължителни полета (email, full_name, role)" }), { status: 400, headers: corsHeaders });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const tempPassword = generateTempPassword();

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email, password: tempPassword, email_confirm: true,
    });
    if (createErr || !created?.user) {
      return new Response(JSON.stringify({ error: createErr?.message ?? "Създаването на потребителя се провали" }), { status: 400, headers: corsHeaders });
    }

    const { error: profileErr } = await admin.from("profiles").insert({
      id: created.user.id, full_name, role, active: true,
    });
    if (profileErr) {
      // Auth акаунтът вече е създаден, но профилният ред не — оставяме
      // го, admin може да довърши ръчно през SQL; по-безопасно от
      // автоматично изтриване на Auth потребител тук.
      return new Response(JSON.stringify({ error: "Auth акаунтът е създаден, но профилният ред гръмна: " + profileErr.message }), { status: 500, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ ok: true, user_id: created.user.id, temp_password: tempPassword }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
}
