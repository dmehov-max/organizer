// Тестове за чистите функции на forward-to-controlisy (0079).
// Пускане: deno test supabase/functions/forward-to-controlisy/

import { assertEquals } from "jsr:@std/assert";
import { buildSubject, isControlisyAddress, pickTarget, secretsEqual } from "./index.ts";

const P = "docs+aaaa@controlisy.bg";
const S = "docs+bbbb@controlisy.bg";

// ---------- pickTarget() ----------

Deno.test("pickTarget: без адреси → null", () => {
  assertEquals(pickTarget({ controlisy_purchases_email: null, controlisy_sales_email: null }, "purchase"), null);
  assertEquals(pickTarget({ controlisy_purchases_email: "", controlisy_sales_email: "  " }, null), null);
});

Deno.test("pickTarget: само Продажби → винаги там, какъвто и вид да е документът (тестът със Скрийн бокс)", () => {
  const c = { controlisy_purchases_email: null, controlisy_sales_email: S };
  assertEquals(pickTarget(c, null), { kind: "sale", to: S });
  assertEquals(pickTarget(c, "purchase"), { kind: "sale", to: S });
});

Deno.test("pickTarget: само Покупки → винаги там", () => {
  const c = { controlisy_purchases_email: P, controlisy_sales_email: null };
  assertEquals(pickTarget(c, "sale"), { kind: "purchase", to: P });
});

Deno.test("pickTarget: два адреса → по вида", () => {
  const c = { controlisy_purchases_email: P, controlisy_sales_email: S };
  assertEquals(pickTarget(c, "purchase"), { kind: "purchase", to: P });
  assertEquals(pickTarget(c, "sale"), { kind: "sale", to: S });
});

Deno.test("pickTarget: два адреса, без вид → null (не гадаем къде да пратим)", () => {
  assertEquals(pickTarget({ controlisy_purchases_email: P, controlisy_sales_email: S }, null), null);
});

Deno.test("pickTarget: интервали около адреса се чистят", () => {
  assertEquals(pickTarget({ controlisy_purchases_email: `  ${P} `, controlisy_sales_email: null }, null)?.to, P);
});

// ---------- isControlisyAddress() ----------

Deno.test("isControlisyAddress: реален формат с + се приема", () => {
  assertEquals(isControlisyAddress("docs+6b8c6cbba9e7f98409fe67ea@controlisy.bg"), true);
  assertEquals(isControlisyAddress("devdocs+ds7ddc+singledoc@controlisy.bg"), true);
});

Deno.test("isControlisyAddress: чужд домейн / подобен домейн / инжекция → не", () => {
  for (const a of ["docs@gmail.com", "docs@controlisy.bg.evil.com", "docs@notcontrolisy.bg", "a@controlisy.bg, b@evil.com", "", "docs@controlisy.bg\nbcc: x@y.z"]) {
    assertEquals(isControlisyAddress(a), false, a);
  }
});

// ---------- buildSubject() ----------

Deno.test("buildSubject: фирма, папка и име на файла", () => {
  assertEquals(buildSubject("Скрийн бокс ООД", "Фактура 1.pdf", "sale"), "Скрийн бокс ООД — Продажби — Фактура 1.pdf");
  assertEquals(buildSubject("X", "a.jpg", "purchase"), "X — Покупки — a.jpg");
});

// ---------- secretsEqual() ----------

Deno.test("secretsEqual: еднакви/различни/различна дължина", () => {
  assertEquals(secretsEqual("abc", "abc"), true);
  assertEquals(secretsEqual("abc", "abd"), false);
  assertEquals(secretsEqual("abc", "ab"), false);
  assertEquals(secretsEqual("", ""), true);
});
