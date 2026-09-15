-- Колона "Забележка" срещу всяка фирма във всички таблици (поискано
-- изрично 2026-09-15). Забележката е към РЕДА в съответната таблица,
-- не една обща за фирмата — иначе бележка "чакам банково извлечение"
-- от Осчетоводяване би стояла и срещу ДДС задачата, а бележка към
-- августовския ДДС би останала висяща и през септември. Общата бележка
-- за фирмата си остава clients.notes (0050) — тя е колоната в "Клиенти".
--
-- Никаква бизнес логика не зависи от тези полета. RLS не се пипа — те
-- са колони в таблици със съществуващи UPDATE политики (tasks_update
-- 0041, inspections_write 0052, incoming_documents_update 0059), освен
-- новата bookkeeping_notes, която следва bookkeeping_progress (0048).

alter table tasks add column if not exists note text;
alter table inspections add column if not exists note text;

-- incoming_documents.note вече съществува (0059) — това е бележката,
-- която КЛИЕНТЪТ пише при качване през upload.html. Нашата вътрешна
-- забележка е отделно поле, за да не се презаписва неговата.
alter table incoming_documents add column if not exists staff_note text;

-- Осчетоводяване е по фирма × година (bookkeeping_progress няма ред
-- на фирма, а ред на отметнат месец), затова забележката е в своя
-- таблица, ключ (client_id, year) — сменяш годината във филтъра и
-- виждаш бележката за нея.
create table if not exists bookkeeping_notes (
  client_id  uuid not null references clients(id) on delete cascade,
  year       int  not null,
  note       text not null,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  primary key (client_id, year)
);

alter table bookkeeping_notes enable row level security;

create policy bookkeeping_notes_select on bookkeeping_notes
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

create policy bookkeeping_notes_write on bookkeeping_notes
  for all to authenticated
  using (is_admin() or is_client_owner(client_id))
  with check (is_admin() or is_client_owner(client_id));
