-- ============================================================
-- Органайзер — "умна" връзка между досие/регистрации и реално
-- включените задължения (client_obligation_settings).
--
-- ДОСЕГА: obligation_types.applies_to_dossier_flag /
-- applies_to_registration_type_id / applies_to_all_legal_entities
-- си стояха в схемата, но НИЩО не ги четеше — чекването на СОЛ/ТД/ГД
-- в досието не палеше/гасеше нищо в чеклиста на клиента. Затова
-- всеки нов клиент трябваше да се тиква ръчно през ~17 чекбокса.
-- Заявено изрично от Дойчин: "Умна програма, а не идиот" (2026-08-09).
--
-- Тук: функция recompute_client_obligations(), която пресмята кои
-- ТЕКУЩИ (valid_to is null) задължения се полагат на даден клиент —
-- по флаг, по регистрация, или "важи за всички ЮЛ" — и upsert-ва
-- enabled=true/false в client_obligation_settings. НИКОГА не пипа
-- ред, който admin е презаписал ръчно (overridden_by_admin=true) —
-- това поле съществуваше от самото начало точно за тази цел.
--
-- Тригери: при промяна на dossier flag, на регистрация, или при
-- създаване на нов клиент (за "важи за всички ЮЛ" веднага при
-- създаване, преди дори да е пипнато досието).
--
-- Плюс: ДДС справка-декларация вече Е представена тук като
-- obligation_type (преди изрично НЕ беше — виж коментар в
-- seed.sql, "Controlisy вече я следи"). Добавена по изрична заявка
-- като допълнителна мрежа за сигурност в Органайзер, не замяна на
-- Controlisy — двойно проследяване на нещо с нулева толерантност
-- към пропуск е разумно, не е бъг.
-- ============================================================

insert into obligation_types
  (code, name, trigger_type, deadline_rule, requires_payment, applies_to_registration_type_id)
select
  'vat_declaration', 'Справка-декларация ДДС', 'recurring',
  '{"type":"day_of_next_month","day":14}'::jsonb, true,
  (select id from registration_types where code = 'vat');

insert into obligation_types
  (code, name, trigger_type, deadline_rule, requires_payment, applies_to_dossier_flag)
values
  ('sol_obr6_monthly_personal_labor', 'Декл. обр. 6 — СОЛ с личен труд (месечно)', 'recurring',
    '{"type":"day_of_next_month","day":25}'::jsonb, true, 'sol_personal_labor');

create or replace function recompute_client_obligations(p_client_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_is_legal_entity boolean;
  v_effective_flags dossier_flag[];
begin
  select (type = 'legal_entity') into v_is_legal_entity from clients where id = p_client_id;
  if v_is_legal_entity is null then return; end if; -- клиентът не съществува

  -- "Ефективни" флагове на клиента — не само буквално чекнатите в
  -- досието, а и еквивалентности между тях. Заявено изрично: СОЛ с
  -- личен труд се третира като ТД за целите на чл. 73, ал. 6 ЗДДФЛ
  -- (справката за доходи от трудови правоотношения) — личният труд
  -- на СОЛ се декларира по същия член. Ако се появят други подобни
  -- еквивалентности занапред, добавят се тук като нов "union select".
  select array_agg(flag) into v_effective_flags from (
    select flag from client_dossier_flags where client_id = p_client_id and ended_on is null
    union
    select 'td'::dossier_flag where exists (
      select 1 from client_dossier_flags
      where client_id = p_client_id and flag = 'sol_personal_labor' and ended_on is null
    )
  ) f;
  v_effective_flags := coalesce(v_effective_flags, array[]::dossier_flag[]);

  -- Включва (или презаписва обратно към true) всяко ТЕКУЩО
  -- задължение, чието условие важи — освен ред, ръчно презаписан
  -- от admin.
  insert into client_obligation_settings (client_id, obligation_type_id, enabled)
  select p_client_id, ot.id, true
  from obligation_types ot
  where ot.valid_to is null
    and (
      (ot.applies_to_all_legal_entities and v_is_legal_entity)
      or (ot.applies_to_dossier_flag is not null and ot.applies_to_dossier_flag = any(v_effective_flags))
      or (ot.applies_to_registration_type_id is not null and exists (
            select 1 from client_registrations r
            where r.client_id = p_client_id and r.registration_type_id = ot.applies_to_registration_type_id and r.ended_on is null
          ))
    )
  on conflict (client_id, obligation_type_id) do update
    set enabled = true, updated_at = now()
    where client_obligation_settings.overridden_by_admin = false
      and client_obligation_settings.enabled = false;

  -- Гаси обратно задължения, чието условие вече не важи (напр.
  -- свален флаг/дерегистрация) — но пак никога ръчно презаписани.
  update client_obligation_settings cos
  set enabled = false, updated_at = now()
  from obligation_types ot
  where cos.client_id = p_client_id
    and cos.obligation_type_id = ot.id
    and cos.overridden_by_admin = false
    and cos.enabled = true
    and ot.valid_to is null
    and not (
      (ot.applies_to_all_legal_entities and v_is_legal_entity)
      or (ot.applies_to_dossier_flag is not null and ot.applies_to_dossier_flag = any(v_effective_flags))
      or (ot.applies_to_registration_type_id is not null and exists (
            select 1 from client_registrations r
            where r.client_id = p_client_id and r.registration_type_id = ot.applies_to_registration_type_id and r.ended_on is null
          ))
    );
end;
$$;

create or replace function trg_sync_obligations_from_row()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform recompute_client_obligations(coalesce(new.client_id, old.client_id));
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_dossier_flags_sync on client_dossier_flags;
create trigger trg_dossier_flags_sync
  after insert or update on client_dossier_flags
  for each row execute function trg_sync_obligations_from_row();

drop trigger if exists trg_registrations_sync on client_registrations;
create trigger trg_registrations_sync
  after insert or update on client_registrations
  for each row execute function trg_sync_obligations_from_row();

create or replace function trg_sync_obligations_on_client_insert()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  perform recompute_client_obligations(new.id);
  return new;
end;
$$;

drop trigger if exists trg_client_insert_sync on clients;
create trigger trg_client_insert_sync
  after insert on clients
  for each row execute function trg_sync_obligations_on_client_insert();

-- Еднократен backfill — иначе новата логика важи само за БЪДЕЩИ
-- промени, а съществуващите клиенти (напр. Мехов Консулт ЕООД, вече
-- с чекнати СОЛ/ТД в досието) остават несинхронизирани до следваща
-- ръчна пипка. При "нулева толерантност към пропуск" това не бива
-- да се остави за случайно откриване по-късно.
do $$
declare
  c record;
begin
  for c in select id from clients loop
    perform recompute_client_obligations(c.id);
  end loop;
end;
$$;
