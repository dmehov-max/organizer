// Органайзер — препраща качен от клиента документ (incoming_documents,
// bucket "incoming") по имейл към папката на фирмата в Controlisy
// (0079). Виж README.md.
//
// Controlisy дава уникален адрес на всяка папка ("имейл към папка",
// docs+<код>@controlisy.bg) — пращаме файла там като прикачен файл,
// от info@ през същия SMTP като vat-documents-reminder. Един файл =
// едно писмо, за да не се слепват документи.
//
// Кой може да вика:
//  - upload-document (сървърно, веднага след качване) — с хедър
//    x-internal-secret = SUPABASE_SERVICE_ROLE_KEY;
//  - таблото ("Прати пак") — с Authorization: Bearer <JWT на активен
//    служител>.
// verify_jwt е ИЗКЛЮЧЕН нарочно: включен той пуска и публичния anon
// ключ, т.е. не пази нищо — проверката е тук.
//
// Изисква secrets: SMTP_HOST, SMTP_USER, SMTP_PASSWORD

import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FROM = "МЕХОВ Консулт <info@mehovconsult.com>";

export type DocKind = "purchase" | "sale" | "bank";
export type ForwardTarget = { kind: DocKind; to: string; label?: string };
export type BankFolder = { label: string; email: string };

export function bankFolders(raw: unknown): BankFolder[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((b) => b && typeof b === "object" && typeof (b as BankFolder).email === "string")
    .map((b) => ({ label: String((b as BankFolder).label ?? "").trim(), email: String((b as BankFolder).email).trim() }))
    .filter((b) => b.email);
}

/** Къде отива документът (0079 + банки 0081). Един-единствен адрес
 * общо → винаги там, независимо от вида. Иначе по вида; банка с
 * няколко папки → по етикета (bank_label), една папка → тя. Без вид
 * или без етикет не гадаем (null → остава за ръчно). */
export function pickTarget(
  client: {
    controlisy_purchases_email: string | null;
    controlisy_sales_email: string | null;
    controlisy_bank_folders?: unknown;
  },
  kind: DocKind | null,
  bankLabel: string | null = null,
): ForwardTarget | null {
  const p = client.controlisy_purchases_email?.trim() || null;
  const s = client.controlisy_sales_email?.trim() || null;
  const banks = bankFolders(client.controlisy_bank_folders);
  const total = (p ? 1 : 0) + (s ? 1 : 0) + banks.length;
  if (total === 0) return null;
  if (total === 1) {
    if (p) return { kind: "purchase", to: p };
    if (s) return { kind: "sale", to: s };
    return { kind: "bank", to: banks[0].email, label: banks[0].label };
  }
  if (kind === "purchase") return p ? { kind, to: p } : null;
  if (kind === "sale") return s ? { kind, to: s } : null;
  if (kind === "bank") {
    if (banks.length === 0) return null;
    if (banks.length === 1) return { kind, to: banks[0].email, label: banks[0].label };
    const b = banks.find((x) => x.label === (bankLabel ?? "").trim());
    return b ? { kind, to: b.email, label: b.label } : null;
  }
  return null;
}

export function isControlisyAddress(email: string): boolean {
  return /^[A-Za-z0-9._+-]+@controlisy\.(bg|com)$/i.test(email.trim());
}

export function buildSubject(clientName: string, filename: string, kind: DocKind, label?: string): string {
  const folder = kind === "sale" ? "Продажби" : kind === "bank" ? (label ? `Банка (${label})` : "Банка") : "Покупки";
  return `${clientName} — ${folder} — ${filename}`;
}

/** Сравнение с постоянно време — да не изтича тайната по тайминг. */
export function secretsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

if (import.meta.main) {
  Deno.serve(handler);
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // --- кой вика ---
  const internal = req.headers.get("x-internal-secret") ?? "";
  let allowed = internal !== "" && secretsEqual(internal, serviceKey);
  if (!allowed) {
    const auth = req.headers.get("Authorization") ?? "";
    const jwt = auth.replace(/^Bearer\s+/i, "");
    if (jwt) {
      const { data: { user } } = await admin.auth.getUser(jwt);
      if (user) {
        const { data: profile } = await admin.from("profiles").select("id, active").eq("id", user.id).maybeSingle();
        allowed = !!profile && profile.active !== false;
      }
    }
  }
  if (!allowed) return json({ error: "Няма достъп." }, 401);

  try {
    const { document_id } = await req.json().catch(() => ({}));
    if (typeof document_id !== "string" || !document_id) return json({ error: "Липсва document_id." }, 400);

    const { data: doc, error: docErr } = await admin
      .from("incoming_documents")
      .select("id, original_filename, storage_path, kind, bank_label, forwarded_at, clients ( id, name, controlisy_purchases_email, controlisy_sales_email, controlisy_bank_folders )")
      .eq("id", document_id).maybeSingle();
    if (docErr) throw docErr;
    if (!doc) return json({ error: "Няма такъв документ." }, 404);
    if (!doc.storage_path) return json({ error: "Документът няма файл при нас (засечен по имейл) — няма какво да се препрати." }, 400);

    const client = doc.clients as unknown as {
      id: string; name: string; controlisy_purchases_email: string | null; controlisy_sales_email: string | null;
      controlisy_bank_folders: unknown;
    };
    const target = pickTarget(client, (doc.kind as DocKind | null) ?? null, (doc.bank_label as string | null) ?? null);
    if (!target) {
      const hasAny = client.controlisy_purchases_email || client.controlisy_sales_email ||
        bankFolders(client.controlisy_bank_folders).length > 0;
      const msg = !hasAny
        ? "Фирмата няма адрес в Controlisy (досие → Controlisy)."
        : "Фирмата има няколко папки в Controlisy, а документът е без вид (покупка/продажба/банка) или папката за този вид липсва.";
      await admin.from("incoming_documents").update({ forward_error: msg }).eq("id", doc.id);
      return json({ ok: false, error: msg }, 422);
    }
    if (!isControlisyAddress(target.to)) {
      const msg = `Адресът „${target.to}“ не е @controlisy.bg — не пращам.`;
      await admin.from("incoming_documents").update({ forward_error: msg }).eq("id", doc.id);
      return json({ ok: false, error: msg }, 422);
    }

    const { data: file, error: dlErr } = await admin.storage.from("incoming").download(doc.storage_path);
    if (dlErr || !file) throw new Error(`Файлът не можа да се свали от Storage: ${dlErr?.message ?? "празен"}`);
    const content = new Uint8Array(await file.arrayBuffer());

    const transport = nodemailer.createTransport({
      host: Deno.env.get("SMTP_HOST")!,
      port: 465,
      secure: true,
      auth: { user: Deno.env.get("SMTP_USER")!, pass: Deno.env.get("SMTP_PASSWORD")! },
    });
    const subject = buildSubject(client.name, doc.original_filename, target.kind, target.label);
    try {
      await transport.sendMail({
        from: FROM,
        to: target.to,
        subject,
        text: `Документ от ${client.name}, качен през Органайзера на Мехов Консулт.`,
        attachments: [{ filename: doc.original_filename, content }],
      });
    } catch (e) {
      const msg = `SMTP: ${e instanceof Error ? e.message : String(e)}`;
      await admin.from("incoming_documents").update({ forward_error: msg }).eq("id", doc.id);
      return json({ ok: false, error: msg }, 502);
    }

    const forwarded_at = new Date().toISOString();
    await admin.from("incoming_documents")
      .update({ forwarded_at, forwarded_to: target.to, forward_error: null, kind: doc.kind ?? target.kind, bank_label: doc.bank_label ?? target.label ?? null })
      .eq("id", doc.id);
    return json({ ok: true, forwarded_to: target.to, forwarded_at, subject });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
