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

/** Входящият номер на потвърждението — за проверка на дублирано
 * качване на един и същ документ. Формати, видени в реални файлове:
 *  - "ВХОДЯЩ НОМЕР НА ДАННИТЕ: ДДС.2215-2676743" (ДДС)
 *  - "Вх. №: 2215И0741032 / 24.07.2026" (чл.55)
 *  - "Вх. № 30E012889408/20.07.2026 13:45:42" (Обр. 1/6)
 * Хваща само буквено-цифровия код, не датата след "/". */
export function extractReferenceNumber(text: string): string | null {
  const patterns = [
    /ВХОДЯЩ\s+НОМЕР\s+НА\s+ДАННИТЕ:\s*([^\s\n]+)/i,
    /Вх\.?\s*№:?\s*([A-Za-zА-Яа-я0-9]+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

/** ЕИК/БУЛСТАТ на фирмата от документа — НАЙ-сигурният начин да
 * проверим дали потвърждението е за правилния клиент (много по-точно
 * от сравнение на име, което варира по изписване: "Х - Y ООД" срещу
 * "Х Y" в базата). Формати, видени в реални файлове:
 *  - "ЕГН/ЛНЧ/Сл.номер/ЕИК по БУЛСТАТ: 175323940" (Обр. 1/6, чл.55)
 *  - "BG205970324" (ДДС номер = BG + ЕИК, махаме BG за директно сравнение) */
export function extractDeclaredEik(text: string): string | null {
  const patterns = [
    /ЕГН\/ЛНЧ\/Сл\.?\s*номер\/ЕИК\s+по\s+БУЛСТАТ:\s*(\d+)/i,
    /ЕИК\s+по\s+БУЛСТАТ:\s*(\d+)/i,
    /\bЕИК:?\s*(\d{9,10})\b/i,
    /\bBG(\d{9,10})\b/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

/** Името на фирмата, както го чете самият документ — резервен, по-
 * слаб сигнал за същата проверка, ползва се само ако ЕИК липсва в
 * текста (напр. документ е зле извлечен). Не е толкова сигурен —
 * имената варират по изписване. */
export function extractDeclaredCompanyName(text: string): string | null {
  const patterns = [
    // 'm' флаг — $ да съвпада в края на РЕДА, не само на целия текст,
    // иначе не спира при нов ред (открито от unit тест).
    /Името\s+на:\s*([^\n]+?)(?:\s{2,}|ЕГН|ЕИК|Автор|$)/im,
    /постъпили\s+от:\s*([^,]+?)(?:\s*,\s*с\s+VIN|\s*,\s*ЕИК|$)/im,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

const LEGAL_FORMS = new Set(["еоод", "оод", "ад", "еад", "ет", "дзжд", "зжд"]);

/** Нормализира име на фирма за сравнение — маха правната форма
 * (ЕООД/ООД/...) и пунктуацията, за да не гърми при "Х - Y ООД"
 * срещу "Х Y" в базата.
 *
 * Съзнателно НЕ ползва \b (word boundary) с кирилица — в JS regex
 * \b се дефинира спрямо \w, което покрива само [A-Za-z0-9_], НЕ и
 * кирилица. Затова /\bоод\b/ никога не съвпада с кирилски текст
 * (нямаше грешка, просто тихо не правеше нищо) — открито от unit
 * тест, не на живо. Токенизиране по интервали го заобикаля изцяло. */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .split(/\s+/)
    .filter((token) => token && !LEGAL_FORMS.has(token))
    .join(" ")
    .trim();
}

/** true = съвпадат (или няма достатъчно данни за сравнение — не
 * вдигаме лъжлива тревога при празен низ). */
export function companyNamesMatch(declared: string, actual: string): boolean {
  const a = normalizeCompanyName(declared);
  const b = normalizeCompanyName(actual);
  if (!a || !b) return true;
  return a.includes(b) || b.includes(a);
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
    const referenceNumber = extractReferenceNumber(text);
    const declaredEik = extractDeclaredEik(text);
    const declaredCompanyName = extractDeclaredCompanyName(text);

    // За коя фирма/задължение реално е тази задача — нужно и за
    // проверката "правилна фирма", и за оборота от ГДД по-долу.
    const { data: taskRow } = await supabase
      .from("tasks")
      .select("client_id, obligation_types ( code ), clients ( eik_egn, name )")
      .eq("id", taskId)
      .single();
    const client = (taskRow as any)?.clients;

    // Проверка "правилна фирма" — ЕИК е сигурният начин; името е
    // резервен, по-слаб сигнал само ако ЕИК липсва в текста.
    let clientNameMismatch = false;
    if (declaredEik && client?.eik_egn) {
      clientNameMismatch = declaredEik !== client.eik_egn;
    } else if (declaredCompanyName && client?.name) {
      clientNameMismatch = !companyNamesMatch(declaredCompanyName, client.name);
    }

    // Проверка за дублиран входящ номер — същото потвърждение,
    // качено повторно (по грешка или от друг колега).
    let duplicateOfId: string | null = null;
    if (referenceNumber) {
      const { data: dup } = await supabase
        .from("attachments")
        .select("id")
        .eq("recognized_reference_number", referenceNumber)
        .neq("id", attachmentId)
        .limit(1)
        .maybeSingle();
      duplicateOfId = dup?.id ?? null;
    }

    await supabase.from("attachments").update({
      recognized_text_excerpt: excerpt,
      recognized_marker: marker,
      recognized_reference_number: referenceNumber,
      recognized_client_name: declaredCompanyName,
      recognized_declared_eik: declaredEik,
      client_name_mismatch: clientNameMismatch,
      duplicate_of_attachment_id: duplicateOfId,
    }).eq("id", attachmentId);

    if (marker) {
      await supabase.from("tasks").update({
        confirmation_status: marker, // 'accepted' | 'rejected' — status/completed_at НЕ се пипат тук
      }).eq("id", taskId);
    }

    // Best-effort оборот — само за задължения от тип ГДД (по code).
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
      details: {
        marker, excerpt_len: excerpt.length, referenceNumber,
        clientNameMismatch, duplicateOfId,
      },
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
