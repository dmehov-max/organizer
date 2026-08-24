-- ============================================================
-- Органайзер — двупосочни съобщения с клиента (поискано 2026-08-24,
-- продължение на 0059/0060). Клиентът вече може не само да качва
-- файлове през upload.html, а и да пише свободен текст; счетоводителят
-- отговаря от досието на клиента в приложението. Двете страни виждат
-- една и съща нишка — виж supabase/functions/client-messages/.
-- ============================================================

create table client_messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  sender text not null check (sender in ('client', 'staff')),
  staff_id uuid references profiles(id),   -- null за sender='client'
  body text not null,
  created_at timestamptz not null default now(),
  -- Двете "прочетено" полета са НЕЗАВИСИМИ от статуса на incoming_documents
  -- (0059/0060) — това е чист чат, не опашка за обработка. Съобщение от
  -- счетоводител се вмъква вече read_by_staff=true (той го е написал),
  -- read_by_client минава true чак когато клиентът отвори upload.html.
  read_by_staff boolean not null default false,
  read_by_client boolean not null default false
);
create index idx_client_messages_client on client_messages(client_id, created_at);

alter table client_messages enable row level security;

create policy client_messages_select on client_messages
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

create policy client_messages_insert on client_messages
  for insert to authenticated
  with check ((is_admin() or is_client_owner(client_id)) and sender = 'staff' and staff_id = auth.uid());

-- Нужна само за да маркираме read_by_staff=true, когато счетоводителят
-- отвори нишката — не пипа body/sender на чужди редове (RLS сама по
-- себе си не ограничава КОИ колони, само кои редове; UI-ят обновява
-- само read_by_staff, дисциплина е на клиента, не на базата тук).
create policy client_messages_update on client_messages
  for update to authenticated
  using (is_admin() or is_client_owner(client_id))
  with check (is_admin() or is_client_owner(client_id));
