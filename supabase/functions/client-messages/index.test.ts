// Тестове за normalizeMessageBody в index.ts.
// Пускане: deno test supabase/functions/client-messages/

import { assertEquals } from "jsr:@std/assert";
import { normalizeMessageBody } from "./index.ts";

Deno.test("normalizeMessageBody: маха заобикалящи интервали", () => {
  assertEquals(normalizeMessageBody("  здравейте  "), "здравейте");
});

Deno.test("normalizeMessageBody: празно (или само интервали) -> null", () => {
  assertEquals(normalizeMessageBody(""), null);
  assertEquals(normalizeMessageBody("   "), null);
  assertEquals(normalizeMessageBody(undefined), null);
});

Deno.test("normalizeMessageBody: над лимита от 4000 символа -> null", () => {
  assertEquals(normalizeMessageBody("а".repeat(4000)), "а".repeat(4000));
  assertEquals(normalizeMessageBody("а".repeat(4001)), null);
});
