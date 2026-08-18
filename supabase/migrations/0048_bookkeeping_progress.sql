-- ============================================================
-- Осчетоводяване — проследяване докъде са обработени Приходи/
-- Разходи/Заплати/Банка на дадена фирма, месец по месец. Поискано
-- изрично 2026-08-18. Съзнателно НЕ е като задачите (obligation_types/
-- tasks) — тук няма нормативен срок, номер на декларация или крон
-- генериране, просто чекбокс "готово ли е този месец за тази
-- категория". Ред съществува само когато е чекнато (uncheck = delete),
-- "няма ред" == "не е готово".
-- ============================================================

create table bookkeeping_progress (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  year int not null,
  category text not null check (category in ('revenue', 'expense', 'salaries', 'bank')),
  month int not null check (month between 1 and 12),
  done_at timestamptz not null default now(),
  done_by uuid references profiles(id),
  unique (client_id, year, category, month)
);

create index idx_bookkeeping_progress_client on bookkeeping_progress(client_id, year);

alter table bookkeeping_progress enable row level security;

-- Видимост/писане следва точно клиентския достъп (is_client_owner) —
-- същия модел като client_dossier_flags и др.
create policy bookkeeping_progress_select on bookkeeping_progress
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

create policy bookkeeping_progress_write on bookkeeping_progress
  for all to authenticated
  using (is_admin() or is_client_owner(client_id))
  with check (is_admin() or is_client_owner(client_id));
