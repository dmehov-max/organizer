// Органайзер — разпознаване на прикачени потвърждения (SPEC.md §4, §11).
//
// Извиква се директно от index.html след успешно качване на файл
// (Database Webhook подходът е блокиран от бъг в Supabase — липсваща
// схема "supabase_functions", виж git история). Приема плоско тяло
// { record: { id, task_id, storage_path, kind } }.
//
// Действие:
//  1. Изтегля файла от частния Storage bucket "attachments".
//  2. Извлича текста (PDF → текст, библиотека "unpdf").
//  3. Търси маркери за приемане/отказ (по образец от реални
//     потвърждения на НАП).
//  4. Записва откъса + маркера в attachments; ако е разпознато,
//     обновява tasks.confirmation_status — но НЕ сменя tasks.status
//     автоматично (човек потвърждава изрично, SPEC.md §4 — риск от
//     фалшив положителен резултат при "без пропуснат срок" политика).
//  5. При ГДД-тип задължение — best-effort опит за оборот (regex,
//     ниска увереност, само предложение — вижте бележката долу).
//
// Изисква secrets: (никакви допълнителни — ползва SUPABASE_URL/
// SUPABASE_SERVICE_ROLE_KEY, инжектирани автоматично)

import { createClient } from "npm:@supabase/supabase-js@2";
import { extractText, getDocumentProxy } from "npm:unpdf";

// CORS — без това браузърът блокира извикването от GitHub Pages към
// Supabase (preflight OPTIONS не получава отговор с правилни хедъри).
// Открито при първи реален тест: функцията изобщо не се стартираше.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ACCEPT_MARKERS = ["е приета", "уведомление за приемане", "прието", "успешно подадена"];
const REJECT_MARKERS = ["не е приета", "не е приет", "грешка", "неуспешно"];

/** Реален образец (Обр. 1/6 съобщение от НАП) не пише просто "приета"/
 * "отхвърлена" — брои: "Брой отхвърлени [нов ред] Декларации обр.1:0".
 * Две находки от реален тест с истински файл:
 *  1. Проста проверка за думата "отхвърл" щеше грешно да маркира ПРИЕТ
 *     документ като отказан, само защото думата се среща с нула до себе си.
 *  2. Между "отхвърлени" и числото има нов ред И думата "обр.1"/"обр.6",
 *     която самата съдържа цифра — затова изключването на цифри в
 *     междинната част ([^:\d]) спираше regex-а преждевременно, преди да
 *     стигне до истинското двоеточие. Сега позволяваме всичко освен
 *     двоеточие (non-greedy до първото ":"), не само "не-цифри". */
export function classify(text: string): "accepted" | "rejected" | null {
  const textLower = text.toLowerCase();

  const rejectedCounts = [...textLower.matchAll(/отхвърлени[^:]*?:\s*(\d+)/g)]
    .map((m) => Number(m[1]));
  if (rejectedCounts.length > 0) {
    return rejectedCounts.some((n) => n > 0) ? "rejected" : "accepted";
  }

  if (REJECT_MARKERS.some((m) => textLower.includes(m))) return "rejected";
  if (ACCEPT_MARKERS.some((m) => textLower.includes(m))) return "accepted";
  return null;
}

/** Best-effort опит за оборот от текста на ГДД — НЕ Е НАДЕЖДНО,
 * само предложение за преглед (SPEC.md §4). Търси ред с "оборот" или
 * "нетни приходи от продажби" последван от число. Трябва да се
 * калибрира срещу реален образец на ГДД потвърждение, който още
 * нямаме — засега е поставено място, не завършена логика. */
export function guessTurnover(text: string): number | null {
  const patterns = [
    /нетни\s+приходи\s+от\s+продажби[^\d]{0,40}([\d\s]+[.,]\d{2})/i,
    /оборот[^\d]{0,40}([\d\s]+[.,]\d{2})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const num = Number(m[1].replace(/\s/g, "").replace(",", "."));
      if (!Number.isNaN(num)) return num;
    }
  }
  return null;
}

// import.meta.main е true само когато Deno изпълнява ТОЗИ файл пряко
// (production, Supabase Edge Runtime) — не и когато тестов файл го
// импортира само за да ползва export-натите чисти функции по-горе.
// Иначе Deno.serve() би стартирал сървър при всяко "deno test".
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
    const payload = await req.json();
    const record = payload.record ?? payload; // поддържа и директен ръчен извик с плоско тяло

    const attachmentId: string = record.id;
    const taskId: string = record.task_id;
    const storagePath: string = record.storage_path;
    const kind: string = record.kind;

    if (kind !== "confirmation") {
      return new Response(JSON.stringify({ ok: true, skipped: "not a confirmation" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: fileBlob, error: dlErr } = await supabase.storage
      .from("attachments")
      .download(storagePath);
    if (dlErr) throw dlErr;

    const buf = new Uint8Array(await fileBlob.arrayBuffer());
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });

    const marker = classify(text);
    const excerpt = text.slice(0, 800);

    await supabase.from("attachments").update({
      recognized_text_excerpt: excerpt,
      recognized_marker: marker,
    }).eq("id", attachmentId);

    if (marker) {
      await supabase.from("tasks").update({
        confirmation_status: marker, // 'accepted' | 'rejected' — status/completed_at НЕ се пипат тук
      }).eq("id", taskId);
    }

    // Best-effort оборот — само за задължения от тип ГДД (по code).
    const { data: taskRow } = await supabase
      .from("tasks")
      .select("client_id, obligation_types ( code )")
      .eq("id", taskId)
      .single();
    const obligationCode = (taskRow as any)?.obligation_types?.code;
    if (obligationCode && String(obligationCode).startsWith("gdd_")) {
      const turnover = guessTurnover(text);
      if (turnover !== null) {
        await supabase.from("tasks").update({ extracted_turnover: turnover }).eq("id", taskId);
        await supabase.from("client_dossier_info").upsert({
          client_id: (taskRow as any).client_id,
          last_known_turnover: turnover,
          turnover_source_task_id: taskId,
          turnover_updated_at: new Date().toISOString(),
        }, { onConflict: "client_id" });
      }
    }

    await supabase.from("audit_log").insert({
      entity_type: "attachment",
      entity_id: attachmentId,
      action: "recognized",
      details: { marker, excerpt_len: excerpt.length },
    });

    return new Response(JSON.stringify({ ok: true, marker }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
