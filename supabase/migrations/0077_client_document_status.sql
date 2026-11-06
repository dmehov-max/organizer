-- ============================================================
-- Органайзер — статус на документите на клиента по период
-- (30.10.2026, продължение на 0075/0076).
--
-- ВЪЗСТАНОВЕНА на 06.11.2026 от supabase_migrations.schema_migrations
-- (версия 20261030193052): приложена директно в Supabase, без файл в
-- репото. SQL-ът по-долу е точно приложеният.
--
-- token — личен линк в писмото (confirm.html?t=<token>), през който
-- клиентът отговаря с един клик: 'done' (пратил е документите) или
-- 'no_documents' (няма документи за периода). Един ред на
-- клиент/период/режим.
-- ============================================================

create table if not exists client_document_status (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  period_label text not null,
  mode text not null check (mode in ('test', 'live')),
  token uuid not null unique default gen_random_uuid(),
  received_at timestamptz,
  response text check (response in ('done', 'no_documents')),
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (client_id, period_label, mode)
);
alter table client_document_status enable row level security;
