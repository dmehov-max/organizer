-- 0068 — изтриване на дублираните задачи "Публикуване на ГФО в ТР"
-- с период 2026.
--
-- Какво се случи: 0065 добави year_offset:-1 на годишните задължения и
-- 0067 поправи вече създадените редове на период 2025 (пуснати на
-- 15.09.2026). Редеплой на generate-tasks (clever-responder) обаче НЕ
-- беше направен, затова на 16.09.2026 08:00 UTC старият код пак сметна
-- периода като текущата година и създаде ПЪЛЕН втори комплект от 31
-- задачи с period_label = '2026' и същия срок 30.09.2026.
--
-- Видим ефект в приложението: обобщеното табло показва само ТЕКУЩИЯ
-- период на всяко задължение — периода на задачата с най-късен due_date
-- (renderObligationSummary в index.html). И двата комплекта имат
-- due_date = 2026-09-30, равенството се разреши в полза на "2026",
-- затова редът "Публикуване на ГФО в ТР" показваше 31 общо / 0
-- завършени / 31 остават вместо реалните 32 / 27 / 5.
--
-- ВАЖНО: пусни първо редеплоя на generate-tasks, иначе кронът ще
-- създаде дубликатите пак на следващата сутрин.
--
-- Проверено преди триенето (21.09.2026, read-only през service_role):
--   * и 31-те реда са status='waiting', без етапи, без номер на
--     декларация, без забележка, без прикачени файлове, без записано
--     време и без редове в task_payments — тоест никаква свършена
--     работа не се губи;
--   * всеки от 31-те клиента има и съответната си задача за период
--     2025, така че никой не остава без ГФО задача.
-- Затова условията по-долу са нарочно стеснени — ако някой ред все пак
-- е пипнат междувременно, той няма да бъде изтрит.

delete from tasks t
using obligation_types o
where t.obligation_type_id = o.id
  and o.code = 'gfo_or_chl38'
  and t.period_label = '2026'
  and t.status = 'waiting'
  and coalesce(t.stage_creation_done, false) = false
  and coalesce(t.stage_review_done, false) = false
  and coalesce(t.stage_submission_done, false) = false
  and t.submission_reference_number is null
  and t.note is null
  and t.confirmation_file_id is null
  and not exists (select 1 from attachments a where a.task_id = t.id)
  and not exists (select 1 from task_time_entries e where e.task_id = t.id)
  and not exists (select 1 from task_payments p where p.task_id = t.id)
-- returning е само за да се види колко реда са паднали при ръчното
-- пускане в SQL Editor-а (очаквано: 31) — резултатът иначе се игнорира.
returning t.id, t.client_id;
