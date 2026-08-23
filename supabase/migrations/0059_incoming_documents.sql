-- ============================================================
-- Органайзер — входящи документи от клиенти (поискано 2026-08-23).
--
-- Проблем: счетоводителите получават документи по имейл от клиенти
-- и понякога пропускат да ги обработят — губят се в потока входяща
-- поща. Решение: всеки клиент получава личен линк за качване
-- (upload.html?t=<upload_token>, БЕЗ логин от негова страна) — качва
-- файл(ове) там, Edge Function-ът "upload-document" ги записва тук.
-- Счетоводителят вижда опашка "Входящи документи" в приложението и
-- маркира изрично "Обработен", когато нанесе документа в
-- счетоводството — целта е нищо да не остане забравено в имейла.
--
-- Съзнателно ОТДЕЛНО от tasks/obligation_types — тук няма нормативен
-- срок/период/крон генериране, просто опашка "получено → обработено",
-- същия дух като bookkeeping_progress (0048) и inspections (0052).
-- ============================================================

-- Личен, непредполагаем токен за клиентския линк — НЕ ЕИК/ID на
-- клиента самия (лесно се познава/enumerate-ва), отделен random uuid.
alter table clients add column upload_token uuid not null default gen_random_uuid() unique;

create table incoming_documents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  original_filename text not null,          -- каквото клиентът е кръстил файла, само за показване
  storage_path text not null,               -- безопасен генериран път, виж upload-document/index.ts
  note text,                                -- свободна бележка, ако клиентът остави такава при качване
  status text not null default 'new' check (status in ('new', 'done')),
  received_at timestamptz not null default now(),
  processed_by uuid references profiles(id),
  processed_at timestamptz
);
create index idx_incoming_documents_client on incoming_documents(client_id);
create index idx_incoming_documents_status on incoming_documents(status);

alter table incoming_documents enable row level security;

-- Видимост/редакция следва клиентската собственост, същия модел като
-- bookkeeping_progress/inspections. Съзнателно БЕЗ insert политика тук
-- за authenticated/anon — единственият писещ път е upload-document
-- (service_role, байпасва RLS), клиентът никога няма Supabase сесия.
create policy incoming_documents_select on incoming_documents
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

create policy incoming_documents_update on incoming_documents
  for update to authenticated
  using (is_admin() or is_client_owner(client_id))
  with check (is_admin() or is_client_owner(client_id));

-- Storage bucket за качените файлове — частен, конвенция за път
-- <client_id>/<генерирано име>, същата идея като attachments (0003) /
-- inspections (0052). ЧЕТЕНЕ само за собственика на клиента/admin;
-- писането пак минава само през Edge Function-а (service_role) —
-- нарочно няма insert политика тук.
insert into storage.buckets (id, name, public)
values ('incoming', 'incoming', false)
on conflict (id) do nothing;

create or replace function incoming_doc_client_id(object_name text)
returns uuid
language sql
stable
as $$
  select (storage.foldername(object_name))[1]::uuid;
$$;

create policy incoming_storage_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'incoming'
    and (is_admin() or is_client_owner(incoming_doc_client_id(name)))
  );

create policy incoming_storage_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'incoming' and is_admin());
