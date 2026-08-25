-- ============================================================
-- Органайзер — дата под зелената отметка в прогрес-таблицата
-- (поискано изрично 2026-08-25): "Създаване"/"Проверка"/"Подаване"
-- пазеха само boolean (0038_task_stage_tracking.sql), без кога точно
-- е станало. Добавя по един timestamptz на всяко от трите, огледално
-- на самото boolean поле — задава се/чисти се заедно с него от
-- клиентския код (index.html), не тук.
--
-- "Прието" вече си има tasks.completed_at, "Платено" — task_payments.
-- paid_at (и двете съществуват отпреди) — не се пипат, само се
-- показват в UI-я до чекмарка.
-- ============================================================

alter table tasks
  add column stage_creation_done_at timestamptz,
  add column stage_review_done_at timestamptz,
  add column stage_submission_done_at timestamptz;
