// Тестове за extractReplyText() в index.ts.
// Пускане: deno test supabase/functions/ai-helper/
//
// Регресионен тест за реален бъг (2026-08-09): content[0] се вземаше
// сляпо, но при разширено "мислене" моделът слага thinking блок
// преди текстовия — content[0].text излизаше undefined тихо (res.ok
// оставаше true, Anthropic не връщаше грешка), помощникът отговаряше
// "(няма отговор)" на реални въпроси.

import { assertEquals } from "jsr:@std/assert";
import { extractReplyText } from "./index.ts";

Deno.test("extractReplyText: обикновен отговор, текстът е content[0]", () => {
  const data = { content: [{ type: "text", text: "Здравей!" }] };
  assertEquals(extractReplyText(data), "Здравей!");
});

Deno.test("extractReplyText: thinking блок ПРЕДИ текстовия (регресия за реален бъг)", () => {
  const data = {
    content: [
      { type: "thinking", thinking: "разсъждавам..." },
      { type: "text", text: "Ето отговора." },
    ],
  };
  assertEquals(extractReplyText(data), "Ето отговора.");
});

Deno.test("extractReplyText: няколко блока, текстът не е първи", () => {
  const data = {
    content: [
      { type: "thinking", thinking: "..." },
      { type: "tool_use", id: "x", name: "y", input: {} },
      { type: "text", text: "Финален отговор." },
    ],
  };
  assertEquals(extractReplyText(data), "Финален отговор.");
});

Deno.test("extractReplyText: празен content масив → fallback текст", () => {
  assertEquals(extractReplyText({ content: [] }), "(няма отговор)");
});

Deno.test("extractReplyText: content липсва изцяло → fallback текст", () => {
  assertEquals(extractReplyText({}), "(няма отговор)");
});

Deno.test("extractReplyText: content не е масив → fallback текст, не гърми", () => {
  assertEquals(extractReplyText({ content: "не е масив" }), "(няма отговор)");
});

Deno.test("extractReplyText: само thinking блокове, без текстов → fallback", () => {
  const data = { content: [{ type: "thinking", thinking: "..." }] };
  assertEquals(extractReplyText(data), "(няма отговор)");
});

Deno.test("extractReplyText: null вход не гърми", () => {
  assertEquals(extractReplyText(null), "(няма отговор)");
});
