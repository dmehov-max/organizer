-- ============================================================
-- Органайзер — обратно запълване на tasks.status = 'completed' за
-- задачи, при които "Подаване" вече е било отметнато преди
-- синхронизацията статус↔отметки да заработи (иначе горното
-- обобщено табло грешно показваше "0 завършени" за реално подадени
-- декларации).
-- ============================================================

update tasks
set status = 'completed',
    completed_at = coalesce(completed_at, now()),
    completed_by = coalesce(completed_by, assigned_user_id)
where stage_submission_done = true
  and status <> 'completed';
