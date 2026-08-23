// Органайзер — публична точка за качване на документи от КЛИЕНТИ
// (не от счетоводителите). Виж миграция 0059 за пълния контекст.
//
// Нарочно е отделна Edge Function, не директен Storage upload от
// upload.html — клиентът няма Supabase Auth сесия изобщо (не искаме
// да го караме да прави акаунт само за да прати една фактура), затова
// няма как RLS с auth.uid() да го пусне директно в bucket-а. Вместо
// това: клиентът праща линка си токен → тази функция (JWT verification
// изключена, като create-user/generate-tasks) → проверява токена
// СЪРВЪРНО срещу clients.upload_token → пише със service_role.
//
// Три режима на едно и също POST тяло:
//  - { token } без file_base64/source_url → само "проверка на
//    линка", връща името на фирмата за приветствие на upload.html,
//    НИЩО не пише.
//  - { token, filename, file_base64, note? } → реално качване от
//    клиента (source='client_upload').
//  - { token, filename, source_url, note? } БЕЗ file_base64 →
//    "засечено по имейл" (source='email_detected', виж 0060) — не
//    мести файла, само логва находка с линк към Gmail писмото.
//    Токенът тук е СЪЩИЯТ upload_token на клиента (0059) — извиква се
//    не от клиента, а от ръчна "проверка на пощата" (виж
//    supabase/functions/upload-document/README.md), четен read-only
//    директно от базата за случая.
//
// Съзнателно НЕ проверява дали клиентът Е активен (active=false) —
// дори неактивен клиент може still да е изпратил документ, по-добре
// да влезе в опашката и счетоводителят да прецени, отколкото тихо да
// изчезне.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Публична точка без Auth зад себе си — трябва твърд горен лимит, за
// да не може някой да задръсти bucket-а/базата. 15MB покрива спокойно
// сканирана фактура/извлечение; base64 инфлира с ~33%, оттам лимитът
// на самия низ по-долу.
const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** Безопасен path за Storage — конвенцията от attachments (0003) /
 * inspections (0052): без кирилица/интервали в КЛЮЧА (Supabase Storage
 * го чупи), оригиналното име остава само в original_filename колоната
 * за показване на счетоводителя. */
export function buildStoragePath(clientId: string, originalFilename: string): string {
  const extMatch = originalFilename.match(/\.[a-zA-Z0-9]+$/);
  const ext = extMatch ? extMatch[0] : "";
  const rand = crypto.randomUUID().slice(0, 8);
  return `${clientId}/${Date.now()}_${rand}${ext}`;
}

/** Приблизителен декодиран размер на base64 низ, без реално декодиране
 * — за бърза граница преди да пробваме atob() на нещо огромно. */
export function estimateDecodedBytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
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
    const { token, filename, file_base64, note, source_url } = await req.json();
    if (!token) {
      return new Response(JSON.stringify({ error: "Липсва линк-токен." }), { status: 400, headers: corsHeaders });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: client, error: clientErr } = await admin
      .from("clients").select("id, name").eq("upload_token", token).maybeSingle();
    if (clientErr || !client) {
      return new Response(JSON.stringify({ error: "Този линк не е валиден. Свържете се с Мехов Консулт за нов линк." }), { status: 404, headers: corsHeaders });
    }

    // Режим "само проверка на линка" — upload.html го вика при
    // зареждане, за да поздрави клиента с името на фирмата.
    if (!file_base64 && !source_url) {
      return new Response(JSON.stringify({ ok: true, client_name: client.name }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Режим "засечено по имейл" (0060) — само лог, файлът остава в
    // Gmail, счетоводителят го отваря през source_url. Проверено
    // ПРЕДИ обичайното качване, защото това клонче няма file_base64.
    if (!file_base64 && source_url) {
      if (!filename) {
        return new Response(JSON.stringify({ error: "Липсва име на файла." }), { status: 400, headers: corsHeaders });
      }
      const { error: insErr } = await admin.from("incoming_documents").insert({
        client_id: client.id, original_filename: filename, note: note || null,
        source: "email_detected", source_url,
      });
      if (insErr) {
        return new Response(JSON.stringify({ error: "Записът се провали: " + insErr.message }), { status: 500, headers: corsHeaders });
      }
      return new Response(JSON.stringify({ ok: true, client_name: client.name }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!filename) {
      return new Response(JSON.stringify({ error: "Липсва име на файла." }), { status: 400, headers: corsHeaders });
    }
    if (estimateDecodedBytes(file_base64) > MAX_FILE_BYTES) {
      return new Response(JSON.stringify({ error: "Файлът е твърде голям (макс. 15MB)." }), { status: 400, headers: corsHeaders });
    }

    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(file_base64), (c) => c.charCodeAt(0));
    } catch {
      return new Response(JSON.stringify({ error: "Файлът не можа да се прочете, опитайте пак." }), { status: 400, headers: corsHeaders });
    }

    const path = buildStoragePath(client.id, filename);
    const { error: upErr } = await admin.storage.from("incoming").upload(path, bytes, {
      contentType: "application/octet-stream",
    });
    if (upErr) {
      return new Response(JSON.stringify({ error: "Качването се провали: " + upErr.message }), { status: 500, headers: corsHeaders });
    }

    const { error: insErr } = await admin.from("incoming_documents").insert({
      client_id: client.id,
      original_filename: filename,
      storage_path: path,
      note: note || null,
    });
    if (insErr) {
      // Файлът вече е в bucket-а, но опашката не знае за него — по-безопасно
      // да оставим "сирачето" в Storage (admin може да го намери ръчно през
      // таблото), отколкото да го трием мълчаливо и клиентът да си мисли,
      // че е изпратен.
      return new Response(JSON.stringify({ error: "Файлът се качи, но записът се провали: " + insErr.message }), { status: 500, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ ok: true, client_name: client.name }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: corsHeaders });
  }
}
