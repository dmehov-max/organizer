// Тестове за businessDaysBetween и помощните дата функции.
// Пускане: deno test supabase/functions/send-notifications/

import { assertEquals } from "jsr:@std/assert";
import { businessDaysBetween, isBusinessDay } from "./index.ts";

Deno.test("businessDaysBetween: същата дата → 0", () => {
  assertEquals(businessDaysBetween("2026-08-10", "2026-08-10", new Set()), 0);
});

Deno.test("businessDaysBetween: 1 работен ден напред (без уикенд по пътя)", () => {
  // понеделник → вторник
  assertEquals(businessDaysBetween("2026-08-10", "2026-08-11", new Set()), 1);
});

Deno.test("businessDaysBetween: прескача уикенд при броене напред", () => {
  // петък (08-14) → понеделник (08-17) = 1 работен ден (събота/неделя не се броят)
  assertEquals(businessDaysBetween("2026-08-14", "2026-08-17", new Set()), 1);
});

Deno.test("businessDaysBetween: прескача официален празник", () => {
  const holidays = new Set(["2026-08-11"]); // вторник е празник
  // понеделник (08-10) → сряда (08-12): вторник е празник, не се брои
  assertEquals(businessDaysBetween("2026-08-10", "2026-08-12", holidays), 1);
});

Deno.test("businessDaysBetween: отрицателно, ако целта е в миналото", () => {
  assertEquals(businessDaysBetween("2026-08-12", "2026-08-10", new Set()) < 0, true);
});

Deno.test("businessDaysBetween: 5 работни дни напред прескача точно един уикенд", () => {
  // понеделник 08-10 + 5 работни дни (вт,ср,чт,пт, [уикенд], пон) = понеделник 08-17
  assertEquals(businessDaysBetween("2026-08-10", "2026-08-17", new Set()), 5);
});

Deno.test("isBusinessDay: събота/неделя не са работни дни", () => {
  assertEquals(isBusinessDay(2026, 8, 8, new Set()), false); // събота
  assertEquals(isBusinessDay(2026, 8, 9, new Set()), false); // неделя
  assertEquals(isBusinessDay(2026, 8, 10, new Set()), true); // понеделник
});

Deno.test("isBusinessDay: официален празник не е работен ден", () => {
  const holidays = new Set(["2026-08-10"]);
  assertEquals(isBusinessDay(2026, 8, 10, holidays), false);
});
