// Хигиена на репото: публично е, затова проверяваме при всеки push, че
// в проследяваните файлове няма клиентски данни и тайни.
// Виж supabase/private/README.md за правилото и изключенията.
//
// Пускане: deno test --allow-read --allow-run supabase/tests/hygiene.test.ts
// (--allow-run само за `git ls-files`; без него обхожда папката).

import { assert, assertEquals } from "jsr:@std/assert";
import { walk } from "jsr:@std/fs@1/walk";
import { fromFileUrl, join, relative } from "jsr:@std/path@1";

const ROOT = fromFileUrl(new URL("../../", import.meta.url));

// Публични институции, не клиенти — може да се споменават.
const ALLOWED_EIKS = new Set([
  "131063188", // НАП
]);

// Измислените ЕИК-та в тестовете: 1000000NN или една и съща цифра
// 9 пъти (111111111) — виж supabase/private/README.md.
const FAKE_EIK = /^10000000\d$|^100000010$|^(\d)\1{8}$|^123456789$/;

const TEXT_EXT = new Set([".ts", ".js", ".sql", ".md", ".html", ".json", ".yml", ".yaml", ".txt", ".csv"]);
const SKIP_DIRS = new Set([".git", "node_modules", "supabase/private", ".claude", "dist"]);

async function trackedFiles(): Promise<string[]> {
  // Предпочитаме git ls-files — точно това, което отива в публичното репо.
  try {
    const cmd = new Deno.Command("git", { args: ["ls-files", "-z"], cwd: ROOT, stdout: "piped", stderr: "null" });
    const out = await cmd.output();
    if (out.success) {
      return new TextDecoder().decode(out.stdout).split("\0").filter(Boolean);
    }
  } catch { /* без --allow-run или без git — обхождаме папката */ }
  const files: string[] = [];
  for await (const e of walk(ROOT, { includeDirs: false })) {
    const rel = relative(ROOT, e.path).replaceAll("\\", "/");
    if ([...SKIP_DIRS].some((d) => rel === d || rel.startsWith(d + "/"))) continue;
    files.push(rel);
  }
  return files;
}

async function readText(rel: string): Promise<string | null> {
  const ext = rel.slice(rel.lastIndexOf("."));
  if (!TEXT_EXT.has(ext)) return null;
  try {
    return await Deno.readTextFile(join(ROOT, rel));
  } catch {
    return null;
  }
}

type Hit = { file: string; line: number; what: string };

async function scan(rule: (line: string) => string | null): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const rel of await trackedFiles()) {
    if (rel.startsWith("supabase/private/") && rel !== "supabase/private/README.md") continue;
    const text = await readText(rel);
    if (text === null) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      const what = rule(line);
      if (what) hits.push({ file: rel, line: i + 1, what });
    });
  }
  return hits;
}

function fmt(hits: Hit[]): string {
  return hits.slice(0, 15).map((h) => `${h.file}:${h.line}: ${h.what}`).join("\n");
}

Deno.test("hygiene: .env и supabase/private/* не са в git", async () => {
  const files = await trackedFiles();
  assert(!files.includes(".env"), ".env е проследен от git!");
  const priv = files.filter((f) => f.startsWith("supabase/private/") && f !== "supabase/private/README.md");
  assertEquals(priv, [], "файлове в supabase/private са проследени: " + priv.join(", "));
});

Deno.test("hygiene: няма реални ЕИК (9 цифри с 1/2 отпред) в проследените файлове", async () => {
  const hits = await scan((line) => {
    const m = line.match(/(?<![\dA-Za-z_-])[12]\d{8}(?![\dA-Za-z_-])/g);
    if (!m) return null;
    const bad = m.filter((e) => !ALLOWED_EIKS.has(e) && !FAKE_EIK.test(e));
    return bad.length ? `ЕИК-подобно число: ${bad.join(", ")}` : null;
  });
  assertEquals(hits, [], "\n" + fmt(hits));
});

Deno.test("hygiene: няма реални Google Drive ID-та на папки (само измислени в тестовете)", async () => {
  const hits = await scan((line) => {
    const m = line.match(/(?<![A-Za-z0-9_-])1[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g);
    if (!m) return null;
    // Измислените съдържат "Fake" или са очевидни азбуки; реалните са случайни.
    const bad = m.filter((id) => !/Fake|AbCdEf|ZyXwVu|QwErTy/.test(id));
    return bad.length ? `Drive ID: ${bad.join(", ")}` : null;
  });
  assertEquals(hits, [], "\n" + fmt(hits));
});

Deno.test("hygiene: няма тайни (service_role JWT, Anthropic/Resend ключове, частни ключове)", async () => {
  const hits = await scan((line) => {
    if (/sb_secret_[A-Za-z0-9_]{10,}/.test(line)) return "sb_secret_ ключ";
    if (/sk-ant-[A-Za-z0-9_-]{10,}/.test(line)) return "Anthropic API ключ";
    if (/\bre_[A-Za-z0-9]{20,}\b/.test(line)) return "Resend ключ";
    if (/eyJhbGciOi[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/.test(line)) return "JWT";
    if (/-----BEGIN (RSA |EC )?PRIVATE KEY-----\\?n[A-Za-z0-9+\/=]{20,}/.test(line)) return "частен ключ";
    return null;
  });
  assertEquals(hits, [], "\n" + fmt(hits));
});

Deno.test("hygiene: имена от supabase/private/client-names.txt не се срещат (ако файлът съществува)", async () => {
  let names: string[] = [];
  try {
    names = (await Deno.readTextFile(join(ROOT, "supabase/private/client-names.txt")))
      .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  } catch {
    return; // няма локален списък — пропускаме тихо (в CI го няма)
  }
  const lower = names.map((n) => n.toLowerCase());
  const hits = await scan((line) => {
    const l = line.toLowerCase();
    const found = lower.filter((n) => l.includes(n));
    return found.length ? `име: ${found.join(", ")}` : null;
  });
  assertEquals(hits, [], "\n" + fmt(hits));
});
