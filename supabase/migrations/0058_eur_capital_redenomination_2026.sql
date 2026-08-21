-- ============================================================
-- Органайзер — "Превалутиране на капитала" (поискано изрично
-- 2026-08-21): еднократна задача за 2026 г., срок 31.12.2026, за
-- ВСИЧКИ активни фирми (ЮЛ) — не важи за физически лица/СОЛ (нямат
-- капитал).
--
-- НЕ използваме recurring/fixed_date+generate-tasks механизма — той
-- преизчислява периода спрямо ТЕКУЩАТА година всеки ден (виж
-- periodsForRule в generate-tasks/index.ts), значи би родил същата
-- задача пак и през 2027, 2028 и т.н., освен ако някой не се върне
-- ръчно да затвори версията точно навреме idle януари 2027 — излишен
-- риск за нещо, което реално е еднократно. Вместо това: trigger_type
-- = 'event' (както болничен/чл.55/чл.88) — generate-tasks изрично НЕ
-- генерира 'event' типове сам (default клона на periodsForRule), а
-- задачите тук се създават директно, еднократно, точно като новата
-- "+ Ново име…" опция в модала "Задача по събитие" в index.html би
-- ги създала — това е същия механизъм, само през SQL вместо клик.
-- ============================================================

do $$
declare
  v_obligation_id uuid;
begin
  insert into obligation_types (
    code, name, trigger_type, deadline_rule,
    requires_payment, requires_confirmation_upload,
    applies_to_all_legal_entities, valid_from, change_reason
  ) values (
    'eur_capital_redenomination_2026', 'Превалутиране на капитала', 'event',
    '{"type": "manual"}'::jsonb,
    false, true,
    false, current_date,
    'Еднократно задължение във връзка с въвеждането на еврото — пререгистрация на капитала в лева към евро, краен срок 31.12.2026'
  )
  returning id into v_obligation_id;

  insert into tasks (client_id, obligation_type_id, period_label, due_date, assigned_user_id, status)
  select c.id, v_obligation_id, '2026', '2026-12-31', c.responsible_user_id, 'waiting'
  from clients c
  where c.active = true and c.type = 'legal_entity';
end $$;
