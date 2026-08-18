-- ============================================================
-- Счетоводителите вече виждат ВСИЧКИ клиенти, не само своите —
-- поискано изрично 2026-08-18 ("за момента да вижда всички
-- клиенти"), отменя частично scoping-а от 0002/0041/0042. Само
-- SELECT се разширява — INSERT/UPDATE/DELETE остават както си бяха
-- (счетоводител създава само на себе си, редактира само admin).
--
-- profiles_select също се разширява по същата причина: "Отговорник"
-- колоната в клиентския списък трябва да показва името на когото и да
-- е отговорник, не само себе си — profiles няма чувствителни полета
-- (само full_name/role/active), безопасно за всички authenticated.
-- ============================================================

drop policy if exists clients_select on clients;
create policy clients_select on clients
  for select to authenticated
  using (is_active());

drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles
  for select to authenticated
  using (is_active());

-- Без тези четирите, клик върху клиент на ДРУГ счетоводител щеше да
-- отвори досието, но да увисне на "Зареждане…" завинаги (dossier-
-- panel/settings-panel/ДДС тогъла четат точно тези таблици,
-- is_client_owner() връща false за чужд клиент).
drop policy if exists client_registrations_select on client_registrations;
create policy client_registrations_select on client_registrations
  for select to authenticated
  using (is_active());

drop policy if exists client_dossier_flags_select on client_dossier_flags;
create policy client_dossier_flags_select on client_dossier_flags
  for select to authenticated
  using (is_active());

drop policy if exists client_dossier_info_select on client_dossier_info;
create policy client_dossier_info_select on client_dossier_info
  for select to authenticated
  using (is_active());

drop policy if exists client_obligation_settings_select on client_obligation_settings;
create policy client_obligation_settings_select on client_obligation_settings
  for select to authenticated
  using (is_active());
