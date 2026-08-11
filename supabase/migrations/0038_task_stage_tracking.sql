-- ============================================================
-- Органайзер — 3 отделни отметки на прогреса вътре в една задача
-- (Създаване/Проверка/Подаване), по образец на Controlisy-таблото за
-- ДДС чек-листове, поискано изрично за общото табло по задължения.
--
-- Независими от съществуващия tasks.status (waiting/in_progress/
-- submitted/completed) — status продължава да управлява KPI/филтри
-- както досега; тези 3 полета са допълнителен, по-фин слой само за
-- визуалния прогрес-преглед, не заменят статуса.
-- ============================================================

alter table tasks
  add column stage_creation_done boolean not null default false,
  add column stage_review_done boolean not null default false,
  add column stage_submission_done boolean not null default false;

-- Backfill от текущия статус, за да не тръгват съществуващите задачи
-- изкуствено от 0% прогрес.
update tasks set stage_creation_done = true
  where status in ('in_progress', 'submitted', 'completed');
update tasks set stage_review_done = true, stage_submission_done = true
  where status in ('submitted', 'completed');
