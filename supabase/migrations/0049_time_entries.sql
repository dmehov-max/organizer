-- ============================================================
-- Засичане на реално отделено време за осчетоводяване по клетка
-- (фирма × категория × месец) в новия таб "Осчетоводяване". In-app
-- старт/стоп бутон — обмисляно беше OS-level/Toggl проследяване, но
-- отпаднало заради сложност и практичност (2026-08-19), връщаме се
-- на по-простия вариант.
--
-- Множество записи на клетка са ОК (старт→прекъсване→пак старт→
-- готово се сумират) — same модел като идеята за bookkeeping_progress
-- самия чекбокс. RLS следва clients (is_client_owner), не profiles —
-- всеки вижда/пише само за собствените си клиенти, admin вижда всички
-- за отчета.
-- ============================================================

create table time_entries (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  year int not null,
  category text not null check (category in ('revenue', 'expense', 'salaries', 'bank')),
  month int not null check (month between 1 and 12),
  user_id uuid not null references profiles(id),
  started_at timestamptz not null default now(),
  stopped_at timestamptz,
  auto_stopped boolean not null default false
);

create index idx_time_entries_client on time_entries(client_id, year, category, month);
create index idx_time_entries_open on time_entries(user_id) where stopped_at is null;

alter table time_entries enable row level security;

create policy time_entries_select on time_entries
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

-- INSERT/UPDATE отделно (не "for all") — пишеш само СВОИ записи
-- (user_id = себе си), но може да е за клиент, чийто отговорник е
-- admin/друг, стига ти да имаш достъп до него (is_client_owner);
-- admin пише за всеки.
create policy time_entries_insert on time_entries
  for insert to authenticated
  with check ((is_admin() or is_client_owner(client_id)) and user_id = auth.uid());

create policy time_entries_update on time_entries
  for update to authenticated
  using (is_admin() or user_id = auth.uid())
  with check (is_admin() or user_id = auth.uid());
