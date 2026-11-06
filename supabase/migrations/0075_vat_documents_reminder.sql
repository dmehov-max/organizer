-- ============================================================
-- Органайзер — напомняне до клиентите за ДДС документи (30.10.2026).
--
-- ВЪЗСТАНОВЕНА на 06.11.2026 от supabase_migrations.schema_migrations
-- (версия 20261030182928): миграцията е била приложена директно в
-- Supabase, без файл в репото. SQL-ът по-долу е точно приложеният.
--
-- automation_settings — ключ/стойност за режима на автоматизацията
--   ('test' с лимит от 3 клиента, или 'live').
-- client_reminders — лог на пратените напомняния, уникален по
--   клиент/вид/период/режим (не се праща два пъти).
-- Cron vat_documents_reminder_daily — всеки ден в 06:00 UTC вика
--   Edge Function vat-documents-reminder; токенът се взима от
--   drive_file_check_2h (0072), за да не попада ключ в git.
-- ============================================================

create table if not exists automation_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table automation_settings enable row level security;

insert into automation_settings (key, value)
values ('vat_documents_reminder', '{"mode": "test", "test_limit": 3}'::jsonb)
on conflict (key) do nothing;

create table if not exists client_reminders (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  kind text not null,
  period_label text not null,
  mode text not null check (mode in ('test', 'live')),
  sent_to text[] not null default '{}',
  status text not null check (status in ('sent', 'failed')),
  error text,
  sent_at timestamptz not null default now(),
  unique (client_id, kind, period_label, mode)
);
alter table client_reminders enable row level security;

do $$
declare
  v_token text;
  v_url text;
begin
  select substring(command from 'Bearer ([A-Za-z0-9._-]+)'),
         substring(command from '(https://[^/]+)/functions/v1/')
    into v_token, v_url
  from cron.job
  where jobname = 'drive_file_check_2h';

  if v_token is null or v_url is null then
    raise exception 'Не намерих токен/URL в drive_file_check_2h — провери cron.job ръчно';
  end if;

  perform cron.schedule(
    'vat_documents_reminder_daily',
    '0 6 * * *',
    format(
      $cmd$select net.http_post(url := %L, headers := %L::jsonb, body := '{}'::jsonb, timeout_milliseconds := 120000);$cmd$,
      v_url || '/functions/v1/vat-documents-reminder',
      jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json')::text
    )
  );
end $$;
