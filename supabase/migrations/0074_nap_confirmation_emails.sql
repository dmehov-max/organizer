-- ============================================================
-- Органайзер — автоматично вписване на „Подаване“ от имейлите на
-- НАП (поискано изрично 2026-10-29). Виж
-- functions/nap-confirmation-email/README.md.
--
-- Потвържденията за получаване („Потвърждение“ / „Система InetVAT2:
-- Потвърждение“ от eServices@nra.bg) идват в пощата на Дойчин.
-- Google Apps Script в същата поща ги праща на edge функцията
-- nap-confirmation-email, която намира задачата и слага отметка
-- „Подаване“ + входящия номер — само ако ги няма.
--
-- Капан: при обр. 1/6 в писмото НЯМА ЕИК, само името на фирмата
-- както е в НАП („АМБУЛАТОРИЯ ЗА ИНДИВИДУАЛНА ПЪРВИЧНА ДЕНТАЛНА
-- ПОМОЩ - МИЛЕНИУМ ДЕНТАЛ КЕЪР“ срещу „АИПДП-МИЛЕНИУМ ДЕНТАЛ КЕЪР
-- ЕООД“ в Органайзера). Засичането по прилика на името вече
-- грешеше при Drive (0073), затова тук:
--   1. ЕИК от писмото (ДДС: „VIN BG…“, други: „ЕИК по ТР/БУЛСТАТ …“);
--   2. точно съвпадение в client_nap_names (псевдоними);
--   3. точно съвпадение на името без правната форма (ЕООД/ООД…);
--   иначе НИЩО не се пише — редът остава с result = 'no_client'.
-- Псевдонимите се учат сами: ако входящият номер вече е вписан
-- РЪЧНО в задача, името от писмото се закача за нейния клиент.
--
-- Идемпотентна по смисъл: всяко писмо се обработва веднъж
-- (gmail_message_id е уникален), повторното изпращане е безвредно.
-- ============================================================

-- Дневник на всяко получено писмо — и за засечените, и за
-- пропуснатите (непознат вид документ, непозната фирма), за да има
-- какво да се прегледа и поправи на ръка.
create table nap_confirmation_emails (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text not null unique,
  received_at timestamptz,
  reference_number text,            -- "30E015846227"
  reference_date date,              -- 21.10.2026
  applicant_name text,              -- името, както е в НАП
  applicant_eik text,               -- само ако го има в писмото
  document_text text,               -- „Подаден документ: …“
  obligation_codes text[] not null default '{}',
  period_label text,                -- "2026-09"
  client_id uuid references clients(id) on delete set null,
  matched_by text check (matched_by in ('eik', 'alias', 'name', 'learned')),
  result text not null check (result in (
    'updated', 'already', 'no_task', 'no_client', 'unknown_document', 'conflict', 'unparsed'
  )),
  task_ids uuid[] not null default '{}',
  details text,
  created_at timestamptz not null default now()
);

create index idx_nap_confirmation_emails_ref on nap_confirmation_emails(reference_number);
create index idx_nap_confirmation_emails_open on nap_confirmation_emails(created_at desc)
  where result in ('no_client', 'unknown_document', 'conflict', 'unparsed', 'no_task');

-- Псевдоними: името на фирмата, както НАП го пише в потвържденията
-- (нормализирано — виж normalizeNapName() в index.ts), → клиент.
create table client_nap_names (
  nap_name_normalized text primary key,
  client_id uuid not null references clients(id) on delete cascade,
  source text not null check (source in ('learned', 'manual')),
  created_at timestamptz not null default now()
);

-- Само функцията (service_role) пише. Персоналът вижда дневника и
-- псевдонимите, за да преглежда пропуснатите писма.
alter table nap_confirmation_emails enable row level security;
alter table client_nap_names enable row level security;

create policy nap_confirmation_emails_select on nap_confirmation_emails
  for select to authenticated using (is_active());
create policy client_nap_names_select on client_nap_names
  for select to authenticated using (is_active());
-- Ръчен псевдоним (когато писмо остане 'no_client') — само admin.
create policy client_nap_names_admin_write on client_nap_names
  for all to authenticated using (is_admin()) with check (is_admin());
