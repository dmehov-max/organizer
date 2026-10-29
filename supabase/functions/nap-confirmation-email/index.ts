// Органайзер — „Подаване“ от имейлите на НАП (поискано изрично
// 2026-10-29). Виж README.md в тази папка и миграция 0074.
//
// Google Apps Script в пощата на Дойчин (apps-script/nap-confirmations.gs)
// праща тук новите „Потвърждение за получаване“ от eServices@nra.bg.
// За всяко писмо: вадим входящия номер, фирмата, вида документ и
// периода → намираме задачата → слагаме „Подаване“ + номера, САМО
// ако ги няма. Статусът на задачата НЕ се пипа — завършването минава
// през „Прието“, както и при ръчната отметка (index.html).
//
// Без логин (verify_jwt изключен) — Apps Script няма Supabase сесия.
// Вместо това: споделена тайна в хедър x-webhook-secret.
//
// Изисква secrets:
//   NAP_MAIL_WEBHOOK_SECRET — същата стойност като в Script Properties

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-webhook-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------------------------------------------------------------
// Чисти помощни функции (тествани в index.test.ts)
// ---------------------------------------------------------------

/** HTML тялото на писмото → текст, клетка/ред на нов ред. Писмата на
 * НАП са таблици „етикет | стойност“ — важното е етикетът и
 * стойността да останат отделни части, не форматирането. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th|tr|p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Текстът → части. Разделители са новите редове и „|“ — така работи
 * и с HTML-а (след htmlToText), и с markdown таблицата, която Gmail
 * понякога дава като plain text. */
export function tokenize(text: string): string[] {
  return text.split(/\n|\|/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s && !/^-+$/.test(s));
}

/** Стойността след етикета — в същата част („Етикет: стойност“) или в
 * следващата. Само първото срещане, т.е. българската част на писмото
 * (след нея идват транслитерация и английски). */
function valueAfter(tokens: string[], label: string): string | null {
  const i = tokens.findIndex((t) => t.startsWith(label));
  if (i < 0) return null;
  const rest = tokens[i].slice(label.length).replace(/^\s*:\s*/, "").trim();
  if (rest) return rest;
  return tokens[i + 1] ?? null;
}

export type NapConfirmation = {
  referenceNumber: string; // "30E015846227"
  referenceDate: string; // "2026-10-21"
  applicantName: string; // както е в НАП
  applicantEik: string | null;
  documentText: string;
};

/** Разчита „Потвърждение за получаване“. null = не е такова писмо или
 * форматът се е сменил — тогава НИЩО не се пише по задачите. */
export function parseNapConfirmation(text: string): NapConfirmation | null {
  const tokens = tokenize(text);
  const reg = valueAfter(tokens, "Уникален регистров идентификатор на получения документ");
  const applicant = valueAfter(tokens, "Заявител на електронната административна услуга");
  const documentText = valueAfter(tokens, "Подаден документ");
  if (!reg || !applicant || !documentText) return null;

  const r = /^([0-9A-Za-zА-Яа-я]+)\s*\/\s*(\d{2})\.(\d{2})\.(\d{4})/.exec(reg);
  if (!r) return null;

  // ДДС: „МЕХОВИ АУТО ЕООД, VIN BG208199054“; други: „…, ЕИК по ТР/БУЛСТАТ 205482691“;
  // обр. 1/6: само име, без ЕИК.
  const eikMatch = /(?:VIN\s*BG|ЕИК[^\d]{0,20})(\d{9,13})\b/i.exec(applicant);
  const applicantName = applicant.split(/,\s*(?:VIN|ЕИК)/i)[0].replace(/[,\s]+$/, "").trim();
  return {
    referenceNumber: r[1].toUpperCase(),
    referenceDate: `${r[4]}-${r[3]}-${r[2]}`,
    applicantName,
    applicantEik: eikMatch ? eikMatch[1] : null,
    documentText,
  };
}

/** Кой вид задължение е подаденият документ и за кой месец. null =
 * вид, който Органайзерът не следи по този начин (напр. декларация по
 * чл. 55, ГДД) — писмото се логва, но не се пипа задача. */
export function classifyDocument(doc: string): { codes: string[]; periodLabel: string } | null {
  const codes: string[] = [];
  if (/образец\s*№\s*1\b/i.test(doc)) codes.push("obr1");
  if (/образец\s*№\s*6\b/i.test(doc)) codes.push("obr6_monthly");
  if (codes.length) {
    const p = /период\s*:?\s*(\d{2})\/(\d{4})/i.exec(doc);
    return p ? { codes, periodLabel: `${p[2]}-${p[1]}` } : null;
  }
  if (/справка-декларация по ЗДДС/i.test(doc)) {
    const p = /период\s*:?\s*(\d{4})(\d{2})\b/i.exec(doc);
    return p ? { codes: ["vat_declaration"], periodLabel: `${p[1]}-${p[2]}` } : null;
  }
  return null;
}

const LEGAL_FORMS = new Set(["ЕООД", "ООД", "ЕТ", "АД", "ЕАД", "СД", "КД"]);

/** Име на фирма за ТОЧНО сравнение: главни букви, без кавички и
 * пунктуация, без правната форма. „ВИЖУАЛАЙЗ“ = „ВИЖУАЛАЙЗ ООД“, но
 * „ДЖИ ДИ ЕМ ГРУП“ ≠ „ДЖИ ДИ ЕМ ГРУП 2019 ЕООД“ — НЕ „съдържа“. */
export function normalizeNapName(name: string): string {
  const words = name.toUpperCase()
    .replace(/["„“”'«»]/g, " ")
    .replace(/[-–—,.;:()]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (words.length && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  while (words.length && LEGAL_FORMS.has(words[0])) words.shift();
  return words.join(" ");
}

export type ClientRow = { id: string; name: string; eik_egn: string | null };
export type MatchedBy = "eik" | "alias" | "name" | "learned";

/** Фирмата от писмото. ЕИК, ако го има (и тогава САМО по ЕИК — чужда
 * фирма с ЕИК не пада към името); иначе псевдоним; иначе точно име,
 * и то само ако е еднозначно. */
export function resolveClient(
  c: Pick<NapConfirmation, "applicantName" | "applicantEik">,
  clients: ClientRow[],
  aliases: Map<string, string>,
): { clientId: string; matchedBy: MatchedBy } | null {
  if (c.applicantEik) {
    const byEik = clients.find((cl) => cl.eik_egn === c.applicantEik);
    return byEik ? { clientId: byEik.id, matchedBy: "eik" } : null;
  }
  const n = normalizeNapName(c.applicantName);
  if (!n) return null;
  const alias = aliases.get(n);
  if (alias) return { clientId: alias, matchedBy: "alias" };
  const byName = clients.filter((cl) => normalizeNapName(cl.name) === n);
  return byName.length === 1 ? { clientId: byName[0].id, matchedBy: "name" } : null;
}

/** Във формата, в който колежките вече ги пишат: "30E015846227/21.10.2026". */
export function formatReference(c: Pick<NapConfirmation, "referenceNumber" | "referenceDate">): string {
  const [y, m, d] = c.referenceDate.split("-");
  return `${c.referenceNumber}/${d}.${m}.${y}`;
}

/** Само номерът, без датата и интервалите — за сравнение с ръчно
 * въведени ("30E015846671", "30E015846671/21.10.2026", "22172838249 / 12.10.2026"). */
export function referenceKey(s: string): string {
  return s.split("/")[0].replace(/\s+/g, "").toUpperCase();
}

export type TaskRow = {
  id: string;
  stage_submission_done: boolean | null;
  submission_reference_number: string | null;
};

/** Какво да се запише в задачата. Нищо вписано на ръка не се
 * презаписва: друг номер → 'conflict' за преглед. */
export function planTaskUpdate(
  task: TaskRow,
  reference: string,
  submittedAtIso: string,
): { outcome: "updated" | "already" | "conflict"; update: Record<string, unknown> | null } {
  const update: Record<string, unknown> = {};
  if (task.submission_reference_number) {
    if (referenceKey(task.submission_reference_number) !== referenceKey(reference)) {
      return { outcome: "conflict", update: null };
    }
  } else {
    update.submission_reference_number = reference;
  }
  if (!task.stage_submission_done) {
    update.stage_submission_done = true;
    update.stage_submission_done_at = submittedAtIso;
  }
  return Object.keys(update).length ? { outcome: "updated", update } : { outcome: "already", update: null };
}

/** Общият резултат за писмото от резултатите по задачи. */
export function overallResult(outcomes: string[]): string {
  if (outcomes.includes("updated")) return "updated";
  if (outcomes.includes("conflict")) return "conflict";
  if (outcomes.length && outcomes.every((o) => o === "already")) return "already";
  return "no_task";
}

/** Сравнение на тайната без ранно излизане по първия различен символ. */
export function secretsEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------
// Handler
// ---------------------------------------------------------------

type IncomingMessage = { id: string; date?: string; subject?: string; html?: string; text?: string };

if (import.meta.main) {
  Deno.serve(handler);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const expected = Deno.env.get("NAP_MAIL_WEBHOOK_SECRET") ?? "";
  if (!secretsEqual(req.headers.get("x-webhook-secret") ?? "", expected)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const body = await req.json();
    const messages: IncomingMessage[] = Array.isArray(body?.messages) ? body.messages.slice(0, 200) : [];
    // dry_run: нищо не се записва — само какво БИ се направило.
    const dryRun = body?.dry_run === true;

    const ids = messages.map((m) => String(m.id ?? "")).filter(Boolean);
    const { data: seenRows, error: seenErr } = await supabase
      .from("nap_confirmation_emails").select("gmail_message_id").in("gmail_message_id", ids.length ? ids : [""]);
    if (seenErr) throw seenErr;
    const seen = new Set((seenRows ?? []).map((r: any) => r.gmail_message_id));

    const { data: clients, error: clErr } = await supabase.from("clients").select("id, name, eik_egn");
    if (clErr) throw clErr;
    const { data: aliasRows, error: alErr } = await supabase.from("client_nap_names").select("nap_name_normalized, client_id");
    if (alErr) throw alErr;
    const aliases = new Map<string, string>((aliasRows ?? []).map((a: any) => [a.nap_name_normalized, a.client_id]));

    const results: Record<string, unknown>[] = [];
    for (const m of messages) {
      if (!m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      // Plain текстът, ако стане; иначе HTML-ът — кой от двата е по-четим
      // зависи от това как Gmail е разбил таблицата.
      const parsed = (m.text ? parseNapConfirmation(m.text) : null) ??
        (m.html ? parseNapConfirmation(htmlToText(m.html)) : null);
      const row: Record<string, unknown> = {
        gmail_message_id: m.id,
        received_at: m.date ?? null,
        result: "unparsed",
        task_ids: [] as string[],
      };

      if (parsed) {
        const reference = formatReference(parsed);
        const kind = classifyDocument(parsed.documentText);
        Object.assign(row, {
          reference_number: parsed.referenceNumber,
          reference_date: parsed.referenceDate,
          applicant_name: parsed.applicantName,
          applicant_eik: parsed.applicantEik,
          document_text: parsed.documentText,
          obligation_codes: kind?.codes ?? [],
          period_label: kind?.periodLabel ?? null,
        });

        let match = resolveClient(parsed, (clients ?? []) as ClientRow[], aliases);

        // Учене: номерът вече е вписан на ръка в задача → това е
        // клиентът; името от писмото става псевдоним за следващия път.
        const { data: known } = await supabase
          .from("tasks").select("client_id")
          .ilike("submission_reference_number", `${parsed.referenceNumber}%`).limit(5);
        const knownClients = [...new Set((known ?? []).map((t: any) => t.client_id))];
        if (knownClients.length === 1) {
          if (!match) {
            match = { clientId: knownClients[0], matchedBy: "learned" };
          } else if (match.clientId !== knownClients[0]) {
            row.result = "conflict";
            row.details = `засечено като ${match.clientId} (${match.matchedBy}), но номерът е вписан при ${knownClients[0]}`;
          }
          const n = normalizeNapName(parsed.applicantName);
          if (!parsed.applicantEik && n && !aliases.has(n) && row.result !== "conflict") {
            aliases.set(n, knownClients[0]);
            if (!dryRun) {
              await supabase.from("client_nap_names")
                .upsert({ nap_name_normalized: n, client_id: knownClients[0], source: "learned" }, { onConflict: "nap_name_normalized", ignoreDuplicates: true });
            }
          }
        }

        if (row.result !== "conflict") {
          if (match) Object.assign(row, { client_id: match.clientId, matched_by: match.matchedBy });
          if (!kind) {
            row.result = "unknown_document";
          } else if (!match) {
            row.result = "no_client";
          } else {
            const { data: tasks, error: tErr } = await supabase
              .from("tasks")
              .select("id, stage_submission_done, submission_reference_number, obligation_types!inner ( code )")
              .eq("client_id", match.clientId)
              .eq("period_label", kind.periodLabel)
              .eq("not_applicable", false)
              .in("obligation_types.code", kind.codes);
            if (tErr) throw tErr;
            const submittedAt = m.date ? new Date(m.date).toISOString() : new Date().toISOString();
            const outcomes: string[] = [];
            for (const t of (tasks ?? []) as any[]) {
              const plan = planTaskUpdate(t, reference, submittedAt);
              outcomes.push(plan.outcome);
              (row.task_ids as string[]).push(t.id);
              if (plan.update && !dryRun) {
                const { error: uErr } = await supabase.from("tasks").update(plan.update).eq("id", t.id);
                if (uErr) throw uErr;
                await supabase.from("audit_log").insert({
                  entity_type: "task",
                  entity_id: t.id,
                  action: "stage_changed",
                  details: { field: "stage_submission_done", value: true, source: "nap_email", gmail_message_id: m.id, ...plan.update },
                });
              }
            }
            row.result = overallResult(outcomes);
            if (outcomes.length < kind.codes.length) {
              row.details = `задачи: ${outcomes.length} от ${kind.codes.length} (${kind.codes.join(", ")})`;
            }
          }
        }
      }

      if (!dryRun) {
        const { error: insErr } = await supabase.from("nap_confirmation_emails").insert(row);
        if (insErr && insErr.code !== "23505") throw insErr; // 23505 = вече обработено паралелно
      }
      results.push(row);
    }

    const count = (r: string) => results.filter((x) => x.result === r).length;
    return json({
      ok: true,
      dry_run: dryRun,
      received: messages.length,
      processed: results.length,
      updated: count("updated"),
      already: count("already"),
      needs_review: results.filter((x) => !["updated", "already"].includes(String(x.result))).length,
      results,
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}
