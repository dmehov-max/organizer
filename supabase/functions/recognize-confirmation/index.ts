// Органайзер — разпознаване на прикачени потвърждения (SPEC.md §4, §11).
//
// Тригерва се от Supabase Database Webhook на INSERT в `attachments`
// (виж README в тази папка за настройка — needs manual setup в
// таблото, не е част от кода). Payload формат от Database Webhooks:
//   { type: "INSERT", table: "attachments", record: {...}, ... }
//
// Действие:
//  1. Изтегля файла от частния Storage bucket "attachments".
//  2. Извлича текста (PDF → текст, библиотека "unpdf" — избрана
//     защото работи в edge/serverless среда без нативни зависимости;
//     НЕ Е ТЕСТВАНА НА ЖИВО още, вижте README).
//  3. Търси маркери за приемане/отказ (по образец от реални
//     потвърждения на НАП — SPEC.md, разговора при изграждането).
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

const ACCEPT_MARKERS = ["е приета", "уведомление за приемане", "прието", "успешно подадена"];
const REJECT_MARKERS = ["отхвърл", "не е приета", "не е приет", "грешка", "неуспешно"];

function classify(textLower: string): "accepted" | "rejected" | null {
  if (REJECT_MARKERS.some((m) => textLower.includes(m))) return "rejected";
  if (ACCEPT_MARKERS.some((m) => textLower.includes(m))) return "accepted";
  return null;
}

/** Best-effort опит за оборот от текста на ГДД — НЕ Е НАДЕЖДНО,
 * само предложение за преглед (SPEC.md §4). Търси ред с "оборот" или
 * "нетни приходи от продажби" последван от число. Трябва да се
 * калибрира срещу реален образец на ГДД потвърждение, който още
 * нямаме — засега е поставено място, не завършена логика. */
function guessTurnover(text: string): number | null {
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

Deno.serve(async (req: Request) => {
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
        headers: { "Content-Type": "application/json" },
      });
    }

    const { data: fileBlob, error: dlErr } = await supabase.storage
      .from("attachments")
      .download(storagePath);
    if (dlErr) throw dlErr;

    const buf = new Uint8Array(await fileBlob.arrayBuffer());
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    const textLower = text.toLowerCase();

    const marker = classify(textLower);
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
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
