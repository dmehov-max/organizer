-- ============================================================
-- Позволява на счетоводител да ВЪВЕЖДА (създава) нови клиенти,
-- назначени на себе си — поискано изрично 2026-08-18. Досегашният
-- модел (0002_rls_policies.sql) беше нарочно "счетоводител вижда
-- само своите; управлява само admin" — тази миграция отваря само
-- INSERT, не UPDATE/DELETE. Редакция на вече съществуващ клиент
-- (име/ЕИК/адрес/досие/отговорник) си остава само за admin.
--
-- Клиентското създаване в index.html пише в три таблици —
-- clients, client_dossier_flags (чекбоксове), client_registrations
-- (ДДС) — затова трите тук получават по една допълнителна INSERT
-- политика. Съществуващите admin-only политики НЕ се трогат
-- (drop-ват се само там, където се налага замяна), новите просто се
-- добавят до тях — RLS политиките за една команда се OR-ват.
-- ============================================================

create policy clients_insert_own on clients
  for insert to authenticated
  with check (responsible_user_id = auth.uid() and is_active());

create policy client_dossier_flags_insert_own on client_dossier_flags
  for insert to authenticated
  with check (is_client_owner(client_id));

create policy client_registrations_insert_own on client_registrations
  for insert to authenticated
  with check (is_client_owner(client_id));
