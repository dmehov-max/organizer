-- ============================================================
-- Връща видимостта на "Клиенти" таба обратно към "само моите" за
-- счетоводител — 0043 (по-рано същия ден) отвори всички клиенти за
-- всеки активен потребител, но е решено да се стесни пак. Поискано
-- изрично 2026-08-18.
--
-- НЕ се пипат: profiles_select (безобидно, само имена), INSERT
-- правата за нов клиент (0042) и UPDATE правата (0044) — само
-- ВИДИМОСТТА на СПИСЪКА се връща назад. С по-тесен SELECT тя вече
-- няма как да достигне чужд клиент през UI-то изобщо, така че
-- широкият UPDATE достъп остава просто неизползван, не е риск.
-- ============================================================

drop policy if exists clients_select on clients;
create policy clients_select on clients
  for select to authenticated
  using (is_admin() or (responsible_user_id = auth.uid() and is_active()));

drop policy if exists client_registrations_select on client_registrations;
create policy client_registrations_select on client_registrations
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

drop policy if exists client_dossier_flags_select on client_dossier_flags;
create policy client_dossier_flags_select on client_dossier_flags
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

drop policy if exists client_dossier_info_select on client_dossier_info;
create policy client_dossier_info_select on client_dossier_info
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

drop policy if exists client_obligation_settings_select on client_obligation_settings;
create policy client_obligation_settings_select on client_obligation_settings
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));
