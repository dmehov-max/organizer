// Тестове за чистите функции в index.ts (buildStoragePath, estimateDecodedBytes).
// Пускане: deno test supabase/functions/upload-document/

import { assertEquals, assertMatch } from "jsr:@std/assert";
import { buildStoragePath, estimateDecodedBytes } from "./index.ts";

Deno.test("buildStoragePath: пази разширението, маха кирилица/интервали от ключа", () => {
  const path = buildStoragePath("11111111-1111-1111-1111-111111111111", "фактура 25 юли.pdf");
  assertMatch(path, /^11111111-1111-1111-1111-111111111111\/\d+_[0-9a-f]{8}\.pdf$/);
});

Deno.test("buildStoragePath: файл без разширение не гърми", () => {
  const path = buildStoragePath("client-id", "scan_001");
  assertMatch(path, /^client-id\/\d+_[0-9a-f]{8}$/);
});

Deno.test("estimateDecodedBytes: приблизително 3/4 от дължината на base64 низа", () => {
  // "YWJj" е base64 на "abc" (3 байта, 4 base64 символа)
  assertEquals(estimateDecodedBytes("YWJj"), 3);
  assertEquals(estimateDecodedBytes("YWJjZA=="), 6);
});
