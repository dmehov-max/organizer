// Органайзер — публична точка за чат с клиента (без логин от негова
// страна), виж миграция 0061. Огледален модел на upload-document:
// клиентският upload_token е единствената "автентикация".
//
// Едно POST тяло, два ефекта в него:
//  - { token } → само чете: връща цялата нишка (текстови съобщения +
//    списък качени документи, слети хронологично за upload.html) и
//    маркира read_by_client=true на всички чакащи съобщения от
//    счетоводителя (клиентът тъкмо отвори страницата).
//  - { token, body } → преди четенето, вмъква ново съобщение от
//    клиента (sender='client'), после връща обновената нишка както
//    по-горе — една обиколка, не две отделни извиквания.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_MESSAGE_LENGTH = 4000;

/** Чиста проверка, изнесена за unit тест — виж index.test.ts. Връща
 * trim-натия текст, или null ако е празно/твърде дълго (тялото решава
 * кое от двете точно за съобщението за грешка). */
export function normalizeMessageBody(raw: unknown): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || trimmed.length > MAX_MESSAGE_LENGTH) return null;
  return trimmed;
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
    const { token, body } = await req.json();
    if (!token) {
      return new Response(JSON.stringify({ error: "Липсва линк-токен." }), { status: 400, headers: corsHeaders });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: client, error: clientErr } = await admin
      .from("clients").select("id, name").eq("upload_token", token).maybeSingle();
    if (clientErr || !client) {
      return new Response(JSON.stringify({ error: "Този линк не е валиден. Свържете се с Мехов Консулт за нов линк." }), { status: 404, headers: corsHeaders });
    }

    if (body) {
      const normalized = normalizeMessageBody(body);
      if (!normalized) {
        return new Response(JSON.stringify({ error: `Съобщението е празно или твърде дълго (макс. ${MAX_MESSAGE_LENGTH} символа).` }), { status: 400, headers: corsHeaders });
      }
      const { error: insErr } = await admin.from("client_messages").insert({
        client_id: client.id, sender: "client", body: normalized,
      });
      if (insErr) {
        return new Response(JSON.stringify({ error: "Съобщението не се записа: " + insErr.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Клиентът е "тук" точно сега (или защото прати съобщение, или
    // защото зареди страницата) — маркираме каквото от счетоводителя
    // чакаше като прочетено, преди да върнем нишката.
    await admin.from("client_messages")
      .update({ read_by_client: true })
      .eq("client_id", client.id).eq("sender", "staff").eq("read_by_client", false);

    const { data: messages, error: msgErr } = await admin
      .from("client_messages").select("id, sender, body, created_at")
      .eq("client_id", client.id).order("created_at", { ascending: true }).limit(300);
    if (msgErr) {
      return new Response(JSON.stringify({ error: "Не успях да заредя нишката: " + msgErr.message }), { status: 500, headers: corsHeaders });
    }

    const { data: documents } = await admin
      .from("incoming_documents").select("id, original_filename, note, status, received_at")
      .eq("client_id", client.id).eq("source", "client_upload")
      .order("received_at", { ascending: true }).limit(300);

    return new Response(JSON.stringify({ ok: true, client_name: client.name, messages: messages ?? [], documents: documents ?? [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
}
