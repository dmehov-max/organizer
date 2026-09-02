// Тестове за чистите функции в index.ts (дата смятане + periodsForRule).
// Пускане: deno test supabase/functions/generate-tasks/

import { assertEquals } from "jsr:@std/assert";
import {
  addMonths,
  daysBetween,
  dueDateAllowed,
  lastDayOfMonth,
  pad,
  periodsForRule,
  shiftToBusinessDay,
  toISODate,
  weekday,
} from "./index.ts";

// ---------- дата помощни функции ----------

Deno.test("pad: подплатяване с нула", () => {
  assertEquals(pad(5), "05");
  assertEquals(pad(12), "12");
});

Deno.test("toISODate: форматиране", () => {
  assertEquals(toISODate(2026, 8, 9), "2026-08-09");
  assertEquals(toISODate(2026, 1, 1), "2026-01-01");
});

Deno.test("weekday: известни дати (0=неделя..6=събота)", () => {
  assertEquals(weekday(2026, 8, 9), 0); // неделя
  assertEquals(weekday(2026, 8, 10), 1); // понеделник
  assertEquals(weekday(2026, 8, 15), 6); // събота
});

Deno.test("lastDayOfMonth: обикновени и високосни месеци", () => {
  assertEquals(lastDayOfMonth(2026, 2), 28); // 2026 не е високосна
  assertEquals(lastDayOfMonth(2024, 2), 29); // 2024 е високосна
  assertEquals(lastDayOfMonth(2026, 4), 30);
  assertEquals(lastDayOfMonth(2026, 12), 31);
});

Deno.test("addMonths: напред и назад, вкл. пренасяне на година", () => {
  assertEquals(addMonths(2026, 7, 1), { y: 2026, m: 8 });
  assertEquals(addMonths(2026, 1, -1), { y: 2025, m: 12 });
  assertEquals(addMonths(2026, 12, 1), { y: 2027, m: 1 });
});

// ---------- shiftToBusinessDay — чл. 22, ал. 7 ДОПК ----------

Deno.test("shiftToBusinessDay: работен ден остава непроменен", () => {
  const holidays = new Set<string>();
  assertEquals(shiftToBusinessDay("2026-08-10", holidays), "2026-08-10"); // понеделник
});

Deno.test("shiftToBusinessDay: събота/неделя се местят до понеделник", () => {
  const holidays = new Set<string>();
  assertEquals(shiftToBusinessDay("2026-08-08", holidays), "2026-08-10"); // събота → понеделник
  assertEquals(shiftToBusinessDay("2026-08-09", holidays), "2026-08-10"); // неделя → понеделник
});

Deno.test("shiftToBusinessDay: официален празник се мести напред", () => {
  const holidays = new Set(["2026-08-10"]);
  assertEquals(shiftToBusinessDay("2026-08-10", holidays), "2026-08-11");
});

Deno.test("shiftToBusinessDay: последователни празник+уикенд се местят до първия истински работен ден", () => {
  // Петък 2026-08-14 е празник, събота/неделя следват → очакваме понеделник 08-17
  const holidays = new Set(["2026-08-14"]);
  assertEquals(shiftToBusinessDay("2026-08-14", holidays), "2026-08-17");
});

// ---------- periodsForRule ----------

const TODAY = { y: 2026, m: 8, d: 9 }; // 2026-08-09, за детерминистични тестове

Deno.test("periodsForRule: day_of_next_month — период е предходният месец", () => {
  const result = periodsForRule({ type: "day_of_next_month", day: 25 }, TODAY);
  assertEquals(result, [{
    periodLabel: "2026-07",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    dueDateRaw: "2026-08-25",
  }]);
});

Deno.test("periodsForRule: day_of_next_month — рязане на деня при по-кратък месец", () => {
  // today = март → период февруари (28 дни през 2026), due ден 31 → следва да падне на 31 март
  const result = periodsForRule({ type: "day_of_next_month", day: 31 }, { y: 2026, m: 3, d: 15 });
  assertEquals(result[0].dueDateRaw, "2026-03-31");
});

Deno.test("periodsForRule: fixed_date — текущата година, фиксирана дата", () => {
  const result = periodsForRule({ type: "fixed_date", month: 6, day: 30 }, TODAY);
  assertEquals(result, [{
    periodLabel: "2026",
    periodStart: "2026-01-01",
    periodEnd: "2026-12-31",
    dueDateRaw: "2026-06-30",
  }]);
});

Deno.test("periodsForRule: fixed_date — не backfill-ва срок, отминал с над 60 дни (нов клиент, стар годишен срок)", () => {
  // TODAY = 2026-08-09; срок 02 март е ~160 дни назад — не се генерира
  const result = periodsForRule({ type: "fixed_date", month: 3, day: 2 }, TODAY);
  assertEquals(result, []);
});

Deno.test("periodsForRule: fixed_date — срок в БЪДЕЩЕТО тази година винаги се генерира", () => {
  const result = periodsForRule({ type: "fixed_date", month: 12, day: 31 }, TODAY);
  assertEquals(result.length, 1);
});

Deno.test("periodsForRule: fixed_date — year_offset -1, период е ПРЕДХОДНАТА година, срокът остава в текущата", () => {
  // напр. ГФО в ТР чл.38: срок 30 септември текущата година, но
  // отчита предходната (2025), не текущата (2026).
  const result = periodsForRule({ type: "fixed_date", month: 9, day: 30, year_offset: -1 }, TODAY);
  assertEquals(result, [{
    periodLabel: "2025",
    periodStart: "2025-01-01",
    periodEnd: "2025-12-31",
    dueDateRaw: "2026-09-30",
  }]);
});

// ---------- daysBetween() ----------

Deno.test("daysBetween: положително, когато to е по-късно", () => {
  assertEquals(daysBetween("2026-03-02", "2026-08-09"), 160);
});

Deno.test("daysBetween: нула за еднаква дата", () => {
  assertEquals(daysBetween("2026-08-09", "2026-08-09"), 0);
});

Deno.test("daysBetween: отрицателно, когато to е по-рано", () => {
  assertEquals(daysBetween("2026-08-09", "2026-06-30"), -40);
});

// ---------- dueDateAllowed() ----------

Deno.test("dueDateAllowed: срок ПРЕДИ tasks_start_date не е позволен", () => {
  assertEquals(dueDateAllowed("2026-06-30", "2026-08-01"), false);
});

Deno.test("dueDateAllowed: срок СЛЕД tasks_start_date е позволен", () => {
  assertEquals(dueDateAllowed("2026-08-15", "2026-08-01"), true);
});

Deno.test("dueDateAllowed: срок точно на tasks_start_date е позволен (включващо)", () => {
  assertEquals(dueDateAllowed("2026-08-01", "2026-08-01"), true);
});

Deno.test("dueDateAllowed: липсваща tasks_start_date не ограничава нищо", () => {
  assertEquals(dueDateAllowed("2020-01-01", null), true);
  assertEquals(dueDateAllowed("2020-01-01", undefined), true);
});

Deno.test("periodsForRule: monthly_advance_zkpo_schedule — яну-мар → 15 апр", () => {
  const result = periodsForRule({ type: "monthly_advance_zkpo_schedule" }, { y: 2026, m: 2, d: 1 });
  assertEquals(result[0].dueDateRaw, "2026-04-15");
});

Deno.test("periodsForRule: monthly_advance_zkpo_schedule — апр-ное → 15-о текущия месец", () => {
  const result = periodsForRule({ type: "monthly_advance_zkpo_schedule" }, { y: 2026, m: 7, d: 1 });
  assertEquals(result[0].dueDateRaw, "2026-07-15");
});

Deno.test("periodsForRule: monthly_advance_zkpo_schedule — декември → 1 дек", () => {
  const result = periodsForRule({ type: "monthly_advance_zkpo_schedule" }, { y: 2026, m: 12, d: 1 });
  assertEquals(result[0].dueDateRaw, "2026-12-01");
});

Deno.test("periodsForRule: quarterly_advance_zkpo_schedule — Q1 → 15 апр", () => {
  const result = periodsForRule({ type: "quarterly_advance_zkpo_schedule" }, { y: 2026, m: 2, d: 1 });
  assertEquals(result[0].periodLabel, "2026-Q1");
  assertEquals(result[0].dueDateRaw, "2026-04-15");
});

Deno.test("periodsForRule: quarterly_advance_zkpo_schedule — Q3 → 1 дек", () => {
  const result = periodsForRule({ type: "quarterly_advance_zkpo_schedule" }, { y: 2026, m: 8, d: 1 });
  assertEquals(result[0].periodLabel, "2026-Q3");
  assertEquals(result[0].dueDateRaw, "2026-12-01");
});

Deno.test("periodsForRule: quarterly_advance_zkpo_schedule — Q4 няма авансова вноска", () => {
  const result = periodsForRule({ type: "quarterly_advance_zkpo_schedule" }, { y: 2026, m: 11, d: 1 });
  assertEquals(result, []);
});

Deno.test("periodsForRule: непознат/событиен тип не генерира нищо (event/manual/before_activity_start)", () => {
  assertEquals(periodsForRule({ type: "quarter_end_plus" }, TODAY), []);
  assertEquals(periodsForRule({ type: "manual" }, TODAY), []);
  assertEquals(periodsForRule({ type: "before_activity_start" }, TODAY), []);
});
