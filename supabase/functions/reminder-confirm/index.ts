// Органайзер — публична точка за потвърждение от клиента (без логин),
// вика се от confirm.html. Линкът е в писмото за документите.
//
// ВЪЗСТАНОВЕН на 2026-11-06 от живата версия в Supabase (v1, на живо
// като "reminder-confirm", verify_jwt изключен) — кодът е бил
// деплойнат директно, без файл в репото. Съдържанието е точно
// деплойнатото.
//
// Страницата е отделна, защото Supabase показва HTML от Edge Functions
// като обикновен текст. Записът става само при натиснат бутон: пощенските
// програми отварят линковете сами, затова { token } само чете, а записва
// едва { token, action }.
//
// token е единствената автентикация и важи 60 дни.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TOKEN_DAYS = 60;
const MONTHS = [
  "януари", "февруари", "март", "април", "май", "юни",
  "юли", "август", "септември", "октомври", "ноември", "декември",
];

export function isToken(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function periodName(label: string): string {
  const [y, m] = label.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** Какво се записва при натиснат бутон. „Получих“ не връща назад вече
 * даден отговор, затова не пипа response. */
export function buildUpdate(
  action: string,
  current: { received_at: string | null },
  now: string,
): Record<string, string> | null {
  const received = { received_at: current.received_at ?? now };
  if (action === "received") return received;
  if (action === "done" || action === "no_documents") {
    return { ...received, response: action, responded_at: now };
  }
  return null;
}

if (import.meta.main) {
  Deno.serve(handler);
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const { token, action } = await req.json().catch(() => ({}));
    if (!isToken(token)) return json({ error: "Невалиден линк" }, 404);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: row, error } = await supabase
      .from("client_document_status")
      .select("id, period_label, received_at, response, created_at, clients ( name )")
      .eq("token", token)
      .maybeSingle();
    if (error) throw error;
    if (!row) return json({ error: "Невалиден линк" }, 404);
    if (Date.now() - new Date(row.created_at).getTime() > TOKEN_DAYS * 86400000) {
      return json({ error: "Линкът е изтекъл" }, 410);
    }

    let current = row;
    if (action !== undefined) {
      const update = buildUpdate(action, row, new Date().toISOString());
      if (!update) return json({ error: "Непознато действие" }, 400);
      const { error: updateErr } = await supabase
        .from("client_document_status").update(update).eq("id", row.id);
      if (updateErr) throw updateErr;
      current = { ...row, ...update };
    }

    return json({
      client_name: (row.clients as unknown as { name: string })?.name,
      period_name: periodName(row.period_label),
      received_at: current.received_at,
      response: current.response,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Грешка" }, 500);
  }
}
