// Органайзер — AI помощник (SPEC.md §12).
//
// Първа версия: статичен системен промпт (обяснява модела на
// данните/статусите/екраните), БЕЗ достъп до живи клиентски данни
// still — това е следваща стъпка (виж бележката долу), не защото е
// пропуснато случайно, а за да пуснем нещо просто и сигурно първо.
//
// Сигурност (SPEC.md §11, §12):
//  - ключът към Claude API стои само тук, сървърно
//  - НЕ ползва service_role към Supabase (засега не пипа Supabase
//    изобщо — когато добавим DB четене, ще е през клиент, скопиран
//    с JWT-то на питащия, никога с пълни права)
//  - системният промпт не съдържа ЕГН/имена на клиенти
//
// Изисква secrets: ANTHROPIC_API_KEY

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const SYSTEM_PROMPT = `Ти си вграден помощник в "Органайзер" — вътрешна система на Мехов Консулт за проследяване на нормативни срокове на счетоводните им клиенти.

Модел накратко:
- Роли: admin (управлява всичко) и счетоводител (вижда само задачите на клиентите, за които е отговорник).
- Всеки клиент си има фиксиран отговорник — всички негови задачи отиват автоматично при него.
- Статуси на задача: Чакаща → В процес → Подадена → Завършена. Завършена става само след като служителят изрично потвърди, дори системата да е разпознала "приета" в прикачения документ — потвърждението никога не затваря задача само̀.
- Плащане се маркира отделно от статуса на задачата.
- Известията са сборни (едно писмо на ден на човек), не по задача.

Отговаряй кратко и конкретно, на български, само по въпроси за работа със самата система. За въпроси извън обхвата ѝ (данъчна консултация по същество, тълкуване на закон) кажи, че трябва да попита Дойчин — не гадай и не давай данъчни съвети.`;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }

  try {
    const { message, history } = await req.json();
    if (!message || typeof message !== "string") {
      return new Response(JSON.stringify({ error: "Missing 'message'" }), { status: 400 });
    }

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
        system: SYSTEM_PROMPT,
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
