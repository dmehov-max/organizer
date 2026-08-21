-- ============================================================
-- Органайзер — "Декл. обр. 1" се преименува на "Декл. обр. 1 и 6"
-- (поискано изрично 2026-08-21, "от следващия месец") — вижте 0056
-- за оттеглянето на отделния obr6_monthly. Обр.1 вече покрива и
-- двете декларации под едно име/една задача.
--
-- НЕ преименуваме реда на място (за разлика от козметичните
-- 0011/0012/0015) — версионираме (нов ред, стария затворен и свързан
-- през superseded_by, конвенцията от 0001_init.sql), защото това НЕ
-- е козметика: вече генерирани/приключени задачи за юли (текущия
-- отворен период към 2026-08-21, dueDate 2026-08-25) трябва да си
-- останат "Декл. обр. 1" в историята — за юли Обр.6 все още се
-- дължеше ОТДЕЛНО. Новото име трябва да важи само за задачи,
-- генерирани от следващия период нататък (август, генерира се от
-- 2026-09-01 — виж generate-tasks/periodsForRule: период винаги е
-- "предходния календарен месец спрямо днес").
--
-- *** ВНИМАНИЕ — НЕ ПУСКАЙ ТАЗИ МИГРАЦИЯ ПРЕДИ 2026-09-01. ***
-- generate-tasks филтрира obligation_types само по `valid_to is
-- null` — НЕ проверява valid_from срещу периода на задачата. Ако се
-- пусне по-рано, докато юлският период е още "текущ" (до 2026-08-31),
-- новият ред веднага ще роди ДУБЛИРАНА юлска задача под новото име,
-- редом до вече съществуващата "Декл. обр. 1" за юли. 0056 (оттегляне
-- на obr6_monthly) е отделна и безопасна за пускане веднага — само
-- тази миграция чака до септември.
--
-- Пусни само ВЕДНЪЖ (не е идемпотентна — втори пуск би създал трета
-- версия на реда и дублирал client_obligation_settings backfill-а).
-- ============================================================

do $$
declare
  v_old_id uuid;
  v_new_id uuid;
begin
  select id into v_old_id from obligation_types where code = 'obr1' and valid_to is null;

  insert into obligation_types (
    code, name, trigger_type, deadline_rule, requires_payment,
    requires_confirmation_upload, applies_to_all_legal_entities,
    applies_to_registration_type_id, applies_to_activity_type_id,
    applies_to_dossier_flag, valid_from, change_reason
  )
  select
    code, 'Декл. обр. 1 и 6', trigger_type, deadline_rule, requires_payment,
    requires_confirmation_upload, applies_to_all_legal_entities,
    applies_to_registration_type_id, applies_to_activity_type_id,
    applies_to_dossier_flag, current_date,
    'Обр.6 отпадна като отделно задължение (0056) — Обр.1 вече покрива и двете под общо име'
  from obligation_types
  where id = v_old_id
  returning id into v_new_id;

  update obligation_types
  set valid_to = current_date, superseded_by = v_new_id
  where id = v_old_id;

  -- КРИТИЧНО: пренасяме "важи ли за този клиент" от старата версия на
  -- новата. client_obligation_settings се съпоставя по КОНКРЕТЕН
  -- obligation_type_id (не по code, виж generate-tasks/index.ts) —
  -- без тази стъпка НИТО ЕДИН клиент няма да има enabled=true ред за
  -- новия obr1 и от 1-ви септември НИКОЙ няма да получи задача —
  -- реален пропуснат срок, не козметика. Пази и overridden_by_admin
  -- (клиент с ръчно изключен обр.1 по друга причина остава изключен).
  insert into client_obligation_settings (client_id, obligation_type_id, enabled, overridden_by_admin)
  select client_id, v_new_id, enabled, overridden_by_admin
  from client_obligation_settings
  where obligation_type_id = v_old_id
  on conflict (client_id, obligation_type_id) do nothing;
end $$;
