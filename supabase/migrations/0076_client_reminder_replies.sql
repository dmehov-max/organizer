-- ============================================================
-- Органайзер — отговори на клиентите на напомнянията за ДДС
-- документи (30.10.2026, продължение на 0075).
--
-- ВЪЗСТАНОВЕНА на 06.11.2026 от supabase_migrations.schema_migrations
-- (версия 20261030191230): приложена директно в Supabase, без файл в
-- репото. SQL-ът по-долу е точно приложеният.
--
-- Всеки отговор по имейл се записва веднъж (message_id е уникален)
-- и се класифицира като 'done' (документите са пратени) или
-- 'question' (клиентът пита нещо).
-- ============================================================

create table if not exists client_reminder_replies (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  period_label text not null,
  mode text not null check (mode in ('test', 'live')),
  message_id text not null unique,
  from_address text not null,
  subject text,
  received_at timestamptz,
  classification text not null check (classification in ('done', 'question')),
  excerpt text,
  created_at timestamptz not null default now()
);
create index if not exists client_reminder_replies_period_idx
  on client_reminder_replies (period_label, mode);
alter table client_reminder_replies enable row level security;
