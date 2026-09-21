// Органайзер — праща по имейл съобщение, което счетоводителят току-що
// е написал на клиента (виж миграция 0070).
//
// Защо изобщо съществува: клиентът няма логин и няма причина да отваря
// upload.html от само себе си. Съобщение, което само стои в базата, на
// практика не е изпратено. Затова index.html вмъква реда в
// client_messages (под RLS, като себе си) и веднага вика това тук.
//
// Защо не направо от браузъра: ключът на Resend не бива да напуска
// сървъра. Функцията проверява ПОД JWT-то на викащия, че той изобщо
// вижда това съобщение (RLS върши проверката вместо нас), и чак тогава
// минава на service_role, за да прочете contact_emails/upload_token и
// да прати писмото.
//
// Идемпотентна през client_messages.emailed_at — второ извикване за
// същото съобщение не праща втори имейл.
//
// Изисква secrets: RESEND_API_KEY, RESEND_FROM, PUBLIC_APP_URL
// (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY са
// автоматично налични в Edge средата).

import { createClient } from "npm:@supabase/supabase-js@2";

// Без тези хедъри браузърът тихо блокира извикването от GitHub Pages и
// изглежда "все едно нищо не се случва" — вече минахме през този урок
// с recognize-confirmation и ai-helper, не го повтаряме.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "Органайзер <onboarding@resend.dev>";
const PUBLIC_APP_URL = Deno.env.get("PUBLIC_APP_URL") ?? "https://dmehov-max.github.io/organizer/";

/** Текстът на писмото. Изнесен, за да е четим и тестваем отделно от
 * мрежата. Съзнателно БЕЗ име на счетоводител — клиентът говори с
 * "Мехов Консулт", точно както в upload.html. */
export function buildEmail(opts: {
  clientName: string;
  body: string;
  contextLabel: string | null;
  link: string;
}): { subject: string; text: string } {
  const subject = opts.contextLabel
    ? `Мехов Консулт — ${opts.contextLabel}`
    : `Мехов Консулт — ново съобщение`;
  const text = [
    `Здравейте,`,
    ``,
    opts.contextLabel ? `Съобщение относно: ${opts.contextLabel}` : `Имате ново съобщение от Мехов Консулт:`,
    ``,
    opts.body,
    ``,
    `Можете да отговорите и да качите документи тук:`,
    opts.link,
    ``,
    `--`,
    `Мехов Консулт ЕООД`,
  ].join("\n");
  return { subject, text };
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
      return new Response(JSON.stringify({ error: "Липсва Authorization header." }), { status: 401, headers: corsHeaders });
    }

    const { message_id } = await req.json();
    if (!message_id) {
      return new Response(JSON.stringify({ error: "Липсва message_id." }), { status: 400, headers: corsHeaders });
    }

    // Стъпка 1 — под ПРАВАТА НА ВИКАЩИЯ. Ако RLS не му дава да види
    // този ред, значи няма работа да праща писмо за него.
    const scoped = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: msg, error: msgErr } = await scoped
      .from("client_messages")
      .select("id, client_id, sender, body, context_label, emailed_at")
      .eq("id", message_id)
      .maybeSingle();
    if (msgErr || !msg) {
      return new Response(JSON.stringify({ error: "Съобщението не е намерено или нямате достъп до него." }), { status: 403, headers: corsHeaders });
    }
    if (msg.sender !== "staff") {
      return new Response(JSON.stringify({ error: "Само съобщения от нас към клиента се пращат по имейл." }), { status: 400, headers: corsHeaders });
    }
    if (msg.emailed_at) {
      return new Response(JSON.stringify({ ok: true, already_sent: true, sent_to: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Стъпка 2 — service_role: contact_emails и upload_token не минават
    // през браузъра и не зависят от това кой е викащият.
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: client, error: clientErr } = await admin
      .from("clients").select("id, name, contact_emails, upload_token").eq("id", msg.client_id).single();
    if (clientErr || !client) {
      return new Response(JSON.stringify({ error: "Клиентът не е намерен." }), { status: 404, headers: corsHeaders });
    }

    const recipients = (client.contact_emails ?? []).filter((e: string) => !!e && e.includes("@"));
    if (recipients.length === 0) {
      // НЕ е грешка: съобщението си стои в нишката и клиентът ще го
      // види, ако отвори линка. Интерфейсът казва ясно, че имейл не е
      // тръгнал, за да се допишат адреси в досието.
      return new Response(JSON.stringify({ ok: true, sent_to: [], reason: "no_contact_emails" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const link = `${PUBLIC_APP_URL.replace(/\/?$/, "/")}upload.html?t=${client.upload_token}`;
    const { subject, text } = buildEmail({
      clientName: client.name,
      body: msg.body,
      contextLabel: msg.context_label ?? null,
      link,
    });

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM, to: recipients, subject, text }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return new Response(JSON.stringify({ ok: false, error: `Resend: ${res.status} ${detail}` }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await admin.from("client_messages").update({ emailed_at: new Date().toISOString() }).eq("id", msg.id);

    return new Response(JSON.stringify({ ok: true, sent_to: recipients }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
