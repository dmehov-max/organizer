// Органайзер — AI помощник (SPEC.md §12).
//
// v2: чете реален контекст (брой задачи/просрочени/най-близък срок)
// за питащия потребител — но ЧРЕЗ клиент, скопиран с НЕГОВОТО JWT,
// не service_role. Ако не дойде валиден Authorization header,
// просто отговаря без данни (не пада, не гадае).
//
// Сигурност (SPEC.md §11, §12):
//  - ключът към Claude API стои само тук, сървърно
//  - Supabase четенето минава през RLS като самия питащ потребител —
//    счетоводител не може да получи данни за клиент, който не е негов,
//    само защото е попитал помощника
//  - системният промпт не съдържа ЕГН; имена на клиенти влизат само
//    в обобщен вид (брой/срокове), не пълен дъмп на данни
//
// Изисква secrets: ANTHROPIC_API_KEY
// (SUPABASE_URL / SUPABASE_ANON_KEY са автоматично налични)

import { createClient } from "npm:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const BASE_PROMPT = `Ти си вграден помощник в "Органайзер" — вътрешна система на Мехов Консулт за проследяване на нормативни срокове на счетоводните им клиенти.

Модел накратко:
- Роли: admin (управлява всичко) и счетоводител (вижда само задачите на клиентите, за които е отговорник).
- Всеки клиент си има фиксиран отговорник — всички негови задачи отиват автоматично при него.
- Статуси на задача: Чакаща → В процес → Подадена → Завършена. Завършена става само след като служителят изрично потвърди, дори системата да е разпознала "приета" в прикачения документ — потвърждението никога не затваря задача само̀.
- Плащане се маркира отделно от статуса на задачата.
- Известията са сборни (едно писмо на ден на човек), не по задача.

Отговаряй кратко и конкретно, на български, само по въпроси за работа със самата система. За въпроси извън обхвата ѝ (данъчна консултация по същество, тълкуване на закон) кажи, че трябва да попита Дойчин — не гадай и не давай данъчни съвети.`;

async function buildUserContext(authHeader: string | null): Promise<string> {
  if (!authHeader) return "";
  try {
    // Клиент, скопиран с JWT-то на питащия — RLS важи както за него в приложението.
    const scoped = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const todayISO = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(new Date());

    const { data: tasks, error } = await scoped
      .from("tasks")
      .select("due_date, status")
      .neq("status", "completed");
    if (error || !tasks) return "";

    const open = tasks.length;
    const overdue = tasks.filter((t: any) => t.due_date < todayISO).length;
    const nextDue = tasks.map((t: any) => t.due_date).sort()[0];

    return `\n\nТекущо състояние за питащия (само това, до което той има достъп): ${open} отворени задачи, от които ${overdue} просрочени${nextDue ? `, най-близък срок ${nextDue}` : ""}. Ползвай това само ако въпросът е свързан с него — не го споменавай без нужда.`;
  } catch (_e) {
    return ""; // без контекст е по-добре от грешка, помощникът просто отговаря по-общо
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }

  try {
    const { message, history } = await req.json();
    if (!message || typeof message !== "string") {
      return new Response(JSON.stringify({ error: "Missing 'message'" }), { status: 400 });
    }

    const authHeader = req.headers.get("Authorization");
    const contextBlock = await buildUserContext(authHeader);

    const messages = [
      ...(Array.isArray(history) ? history.slice(-10) : []),
      { role: "user", content: message },
    ];

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 500,
        system: BASE_PROMPT + contextBlock,
        messages,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return new Response(JSON.stringify({ error: `Anthropic ${res.status}: ${body}` }), { status: 502 });
    }

    const data = await res.json();
    const reply = data.content?.[0]?.text ?? "(няма отговор)";

    return new Response(JSON.stringify({ reply }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
