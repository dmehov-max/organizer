-- ============================================================
-- Декл. обр. 1 трябва да важи и за самоосигуряващи се лица (СОЛ),
-- не само за клиенти с ТД — поискано изрично 2026-08-18 ("Всички
-- фирми които имат СОЛ трябва да имат [обр.] 1"). СОЛ-ът си подава
-- обр.1 за себе си всеки месец, независимо дали има и служители на
-- трудов договор.
--
-- НЕ разширяваме общата 'sol'→'td' еквивалентност в v_effective_flags
-- (както е направено за 'sol_personal_labor') — 'td' се ползва и от
-- obr6_monthly/chl73_al6/maternity/sick_leave, които правилно НЕ
-- трябва да важат за чист СОЛ без личен труд. Затова тук е точково
-- добавено условие само за obr1 (по code), навсякъде другаде логиката
-- на recompute_client_obligations() е непроменена.
-- ============================================================

create or replace function recompute_client_obligations(p_client_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_is_legal_entity boolean;
  v_effective_flags dossier_flag[];
  v_has_sol boolean;
begin
  select (type = 'legal_entity') into v_is_legal_entity from clients where id = p_client_id;
  if v_is_legal_entity is null then return; end if;

  select array_agg(flag) into v_effective_flags from (
    select flag from client_dossier_flags where client_id = p_client_id and ended_on is null
    union
    select 'td'::dossier_flag where exists (
      select 1 from client_dossier_flags
      where client_id = p_client_id and flag = 'sol_personal_labor' and ended_on is null
    )
  ) f;
  v_effective_flags := coalesce(v_effective_flags, array[]::dossier_flag[]);

  v_has_sol := exists (
    select 1 from client_dossier_flags
    where client_id = p_client_id and flag in ('sol', 'sol_personal_labor') and ended_on is null
  );

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
      or (ot.code = 'obr1' and v_has_sol)
    )
  on conflict (client_id, obligation_type_id) do update
    set enabled = true, updated_at = now()
    where client_obligation_settings.overridden_by_admin = false
      and client_obligation_settings.enabled = false;

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
      or (ot.code = 'obr1' and v_has_sol)
    );
end;
$$;

-- Еднократен backfill за вече съществуващи клиенти със СОЛ флаг —
-- иначе новото правило важи само за бъдещи промени в досието.
do $$
declare
  c record;
begin
  for c in select distinct client_id as id from client_dossier_flags where flag in ('sol', 'sol_personal_labor') and ended_on is null loop
    perform recompute_client_obligations(c.id);
  end loop;
end $$;
