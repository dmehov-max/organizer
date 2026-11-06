// Тестове за чистите функции на forward-to-controlisy (0079).
// Пускане: deno test supabase/functions/forward-to-controlisy/

import { assertEquals } from "jsr:@std/assert";
import { bankFolders, buildSubject, isControlisyAddress, pickTarget, secretsEqual } from "./index.ts";

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

// ---------- pickTarget() с банки (0081) ----------

const B1 = { label: "03-Банка", email: "docs+cccc@controlisy.bg" };
const B2 = { label: "04-Банка - 335/Уни", email: "docs+dddd@controlisy.bg" };

Deno.test("pickTarget: само една банкова папка и нищо друго → винаги там", () => {
  const c = { controlisy_purchases_email: null, controlisy_sales_email: null, controlisy_bank_folders: [B1] };
  assertEquals(pickTarget(c, null), { kind: "bank", to: B1.email, label: B1.label });
  assertEquals(pickTarget(c, "purchase"), { kind: "bank", to: B1.email, label: B1.label });
});

Deno.test("pickTarget: покупки + една банка, вид 'bank' → банката, без етикет", () => {
  const c = { controlisy_purchases_email: P, controlisy_sales_email: null, controlisy_bank_folders: [B1] };
  assertEquals(pickTarget(c, "bank"), { kind: "bank", to: B1.email, label: B1.label });
  assertEquals(pickTarget(c, "purchase"), { kind: "purchase", to: P });
});

Deno.test("pickTarget: няколко банки → по етикет; без/грешен етикет → null", () => {
  const c = { controlisy_purchases_email: P, controlisy_sales_email: S, controlisy_bank_folders: [B1, B2] };
  assertEquals(pickTarget(c, "bank", "04-Банка - 335/Уни"), { kind: "bank", to: B2.email, label: B2.label });
  assertEquals(pickTarget(c, "bank", " 03-Банка "), { kind: "bank", to: B1.email, label: B1.label });
  assertEquals(pickTarget(c, "bank", null), null);
  assertEquals(pickTarget(c, "bank", "няма такава"), null);
});

Deno.test("pickTarget: вид, за който фирмата няма папка → null (не пращаме на друга)", () => {
  const c = { controlisy_purchases_email: P, controlisy_sales_email: null, controlisy_bank_folders: [B1] };
  assertEquals(pickTarget(c, "sale"), null);
  const c2 = { controlisy_purchases_email: P, controlisy_sales_email: S, controlisy_bank_folders: [] };
  assertEquals(pickTarget(c2, "bank"), null);
});

Deno.test("bankFolders: боклук в JSON-а се игнорира", () => {
  assertEquals(bankFolders(null), []);
  assertEquals(bankFolders("x"), []);
  assertEquals(bankFolders([null, {}, { label: "a" }, { label: "b", email: " docs+1@controlisy.bg " }]), [{ label: "b", email: "docs+1@controlisy.bg" }]);
});

Deno.test("buildSubject: банка с етикет", () => {
  assertEquals(buildSubject("X", "izv.pdf", "bank", "03-Банка Mypos"), "X — Банка (03-Банка Mypos) — izv.pdf");
  assertEquals(buildSubject("X", "izv.pdf", "bank"), "X — Банка — izv.pdf");
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
