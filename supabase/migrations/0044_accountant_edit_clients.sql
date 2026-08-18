-- ============================================================
-- Счетоводителите вече могат да РЕДАКТИРАТ съществуващи клиенти
-- (не само да гледат/създават) — поискано изрично 2026-08-18,
-- продължение на 0043. Изтриване на клиент (clients_admin_delete)
-- НЕ се пипа тук — остава само за admin, не е поискано.
-- ============================================================

drop policy if exists clients_admin_update on clients;
create policy clients_update on clients
  for update to authenticated
  using (is_active())
  with check (is_active());

drop policy if exists client_dossier_flags_admin_write on client_dossier_flags;
create policy client_dossier_flags_write on client_dossier_flags
  for all to authenticated
  using (is_active())
  with check (is_active());

drop policy if exists client_registrations_admin_write on client_registrations;
create policy client_registrations_write on client_registrations
  for all to authenticated
  using (is_active())
  with check (is_active());

drop policy if exists client_obligation_settings_admin_write on client_obligation_settings;
create policy client_obligation_settings_write on client_obligation_settings
  for all to authenticated
  using (is_active())
  with check (is_active());
