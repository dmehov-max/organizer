-- ============================================================
-- Проверки и ревизии — отделен модул от обикновените периодични
-- задължения (обр.1/6, ДДС и т.н.). Всяка проверка/ревизия е
-- еднократно събитие за даден клиент, със срок и прикачен PDF
-- (напр. покана/акт от НАП), видимо за отговорника на клиента.
-- Поискано изрично 2026-08-19 ("под задачи" — позиционирано до Задачи
-- в менюто, но е отделен модул, не разширение на tasks/obligation_types).
-- ============================================================

create table inspections (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null check (kind in ('inspection', 'audit')), -- проверка / ревизия
  title text not null,
  due_date date,
  storage_path text, -- PDF в bucket 'inspections', <client_id>/<файл>
  status text not null default 'open' check (status in ('open', 'closed')),
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index idx_inspections_client on inspections(client_id);

alter table inspections enable row level security;

create policy inspections_select on inspections
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

create policy inspections_write on inspections
  for all to authenticated
  using (is_admin() or is_client_owner(client_id))
  with check (is_admin() or is_client_owner(client_id));

-- ------------------------------------------------------------
-- Storage bucket — отделен от 'attachments' (0003), защото пътищата
-- там се четат по task_id, тук трябва по client_id. Частен bucket,
-- същия модел на достъп (is_client_owner на първата "папка" в пътя).
-- ------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('inspections', 'inspections', false)
on conflict (id) do nothing;

create or replace function inspection_client_id(object_name text)
returns uuid
language sql
stable
as $$
  select (storage.foldername(object_name))[1]::uuid;
$$;

create policy inspections_storage_select on storage.objects
  for select to authenticated
  using (bucket_id = 'inspections' and (is_admin() or is_client_owner(inspection_client_id(name))));

create policy inspections_storage_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'inspections' and (is_admin() or is_client_owner(inspection_client_id(name))));

create policy inspections_storage_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'inspections' and is_admin());
