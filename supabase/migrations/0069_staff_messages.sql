-- ============================================================
-- Органайзер — вътрешни съобщения между служителите (поискано
-- 2026-09-21). Досега комуникация имаше само НАВЪН към клиента
-- (client_messages, 0061); между Дойчин, Нерман и Емилия нямаше
-- нищо освен забележките по ред (0066), които са едно поле за
-- презаписване, без автор, без адресат и без известие.
--
-- Съзнателно ЕДНА таблица с НЕЗАДЪЛЖИТЕЛЕН контекст, а не отделни
-- "коментари по задача" и "лични съобщения" — същият ред се
-- рендерира на две места според това дали task_id е попълнен:
--   task_id попълнен  → нишка в разгънатата задача (+ в "Съобщения")
--   task_id празен    → само в личния таб "Съобщения"
-- Така "по задача" и "друго" са един механизъм, едно броянче и
-- един код, вместо две почти еднакви таблици.
-- ============================================================

create table staff_messages (
  id uuid primary key default gen_random_uuid(),
  author_id    uuid not null references profiles(id),
  recipient_id uuid not null references profiles(id),

  -- Контекстът е незадължителен И "мек": on delete set null, защото
  -- разговорът е между хора и трябва да преживее изтриването на
  -- задачата (0068 изтри 31 задачи наведнъж — съобщенията по тях не
  -- бива да изчезнат с тях).
  task_id   uuid references tasks(id)   on delete set null,
  client_id uuid references clients(id) on delete set null,

  -- Снимка на контекста като текст, направена при изпращането.
  -- Причина: (1) преживява изтриването на задачата, (2) заобикаля
  -- RLS капана — счетоводител вижда само СВОИТЕ клиенти (0047), но
  -- ако му пишеш за чужда фирма, той трябва да разбере ЗА КАКВО
  -- става дума, дори да не може да отвори реда. Името на фирмата тук
  -- е видимо за адресата по изричната воля на изпращача, не по
  -- подразбиране — затова е безопасно спрямо стесняването от 0047.
  context_label text,

  body text not null,
  created_at timestamptz not null default now(),
  -- Едно поле, не две като в client_messages (там имаше две страни с
  -- различни прочитания) — тук адресатът е един.
  read_at timestamptz
);

-- Броянчето пита точно това; частичният индекс държи заявката евтина
-- независимо колко история се натрупа.
create index idx_staff_messages_inbox on staff_messages(recipient_id, created_at desc)
  where read_at is null;
create index idx_staff_messages_recipient on staff_messages(recipient_id, created_at desc);
create index idx_staff_messages_task on staff_messages(task_id, created_at)
  where task_id is not null;

alter table staff_messages enable row level security;

-- Видимост:
--  · участниците (автор/адресат) винаги — това важи и за личните
--    съобщения без контекст;
--  · закачените за задача се виждат и от всеки, който вижда самата
--    задача (огледално на tasks_select от 0041) — така нишката по
--    задача е истинска нишка, а не N разговора по двойки.
--
-- СЪЗНАТЕЛНО РЕШЕНИЕ: admin НЯМА право да чете чужди лични съобщения
-- без контекст. По задачи вижда всичко (той и без това вижда всяка
-- задача). Ако Дойчин поиска пълна видимост върху личните — това е
-- една ред промяна тук, но е негово изрично решение, не мое
-- подразбиране.
create policy staff_messages_select on staff_messages
  for select to authenticated
  using (
    author_id = auth.uid()
    or recipient_id = auth.uid()
    or (task_id is not null and exists (
      select 1 from tasks t
      where t.id = staff_messages.task_id
        and (is_admin() or (t.assigned_user_id = auth.uid() and is_active()))
    ))
  );

-- Всеки активен пише на всеки (екипът е малък и всички са колеги —
-- потвърдено 2026-09-21). Авторът не може да се представи за друг.
create policy staff_messages_insert on staff_messages
  for insert to authenticated
  with check (author_id = auth.uid() and is_active());

-- Само адресатът маркира прочетено. Както в 0061, RLS ограничава
-- КОИ редове, не кои колони — дисциплината "пипай само read_at" е в
-- index.html. Разликата е, че тук авторът е изключен от UPDATE
-- изобщо, тоест никой не може да редактира изпратен текст.
create policy staff_messages_update on staff_messages
  for update to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());
