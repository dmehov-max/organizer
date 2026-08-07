-- ============================================================
-- Органайзер — начална схема (Supabase / Postgres)
-- Мехов Консулт — проследяване на нормативни срокове.
-- Виж ../../SPEC.md за пълния модел, обосновка и каталог на
-- задълженията. Тази миграция покрива Прогрес #1 и #2 от SPEC.md.
--
-- Ревизирана след технически преглед (виж SPEC.md, "Бележки от
-- ревю"): версиониран каталог, история на досието, празничен
-- календар, разширен жизнен цикъл, идемпотентни известия.
--
-- Всички дати/срокове се смятат в часова зона Europe/Sofia, не UTC
-- (изчисляването е в Edge Function-а, не в тази схема, но е важно
-- за всеки, който пише срещу нея).
--
-- RLS политиките са само включени (fail-closed) тук — конкретните
-- политики идват в 0002_rls_policies.sql, за да няма прозорец без
-- защита между тази стъпка и следващата.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- Справочни (стабилни) типове
-- ------------------------------------------------------------

create type user_role as enum ('admin', 'accountant');
create type client_type as enum ('legal_entity', 'individual');
create type obligation_trigger as enum ('recurring', 'event', 'activity');
create type task_status as enum ('waiting', 'in_progress', 'submitted', 'completed');
create type confirmation_status as enum ('pending', 'accepted', 'rejected');
create type attachment_kind as enum ('confirmation', 'payment_proof', 'other');
create type dossier_flag as enum ('sol', 'td', 'gd');
create type task_link_type as enum ('correction', 'next_phase');

-- ------------------------------------------------------------
-- Потребители
-- auth.users идва от Supabase Auth; тук само разширяващ профил.
-- Акаунти се създават само от admin (SPEC.md §2) — без публична
-- регистрация, затова няма отделен "signup" механизъм тук.
-- ------------------------------------------------------------

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role user_role not null default 'accountant',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Клиенти (SPEC.md §3)
-- ------------------------------------------------------------

create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type client_type not null,
  eik_egn text not null,
  responsible_user_id uuid references profiles(id),
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index idx_clients_eik_egn on clients(eik_egn);
create index idx_clients_responsible on clients(responsible_user_id);

-- ------------------------------------------------------------
-- Регистрации — с история (SPEC.md §3)
-- ------------------------------------------------------------

create table registration_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,        -- 'vat', 'insurer', ...
  name text not null
);

create table client_registrations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  registration_type_id uuid not null references registration_types(id),
  started_on date not null,
  ended_on date,                     -- null = все още активна
  created_at timestamptz not null default now()
);
create index idx_client_registrations_client on client_registrations(client_id);

-- ------------------------------------------------------------
-- Дейности (SPEC.md §3) — списъкът се допълва при нужда
-- ------------------------------------------------------------

create table activity_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,        -- 'tourism_accommodation', 'rental', ...
  name text not null
);

create table client_activities (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  activity_type_id uuid not null references activity_types(id),
  started_on date,
  ended_on date,
  created_at timestamptz not null default now()
);
create index idx_client_activities_client on client_activities(client_id);

-- ------------------------------------------------------------
-- Досие на клиента — СОЛ / ТД / ГД, ВЕЧЕ С ИСТОРИЯ ПО ПЕРИОД.
--
-- Ревю бележка: фирма може да има ТД само част от годината (напр.
-- освободи всички служители през август) — тогава Обр. 1 не се
-- дължи за месеците без ТД. Прости булеви флагове не могат да
-- изразят това, затова е таблица с валидност, като регистрациите.
-- "Активен в момента" = ended_on is null.
-- ------------------------------------------------------------

create table client_dossier_flags (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  flag dossier_flag not null,
  started_on date not null,
  ended_on date,
  created_at timestamptz not null default now()
);
create index idx_dossier_flags_client on client_dossier_flags(client_id, flag);

-- Оборот и друга "мека" информация от досието остава отделно —
-- това не е период-базирано, а последна известна стойност.
create table client_dossier_info (
  client_id uuid primary key references clients(id) on delete cascade,
  last_known_turnover numeric(14,2),
  turnover_source_task_id uuid,     -- FK добавен по-долу, след create table tasks
  turnover_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Видове задължения (шаблони) — SPEC.md §3, §6 — ВЕЧЕ ВЕРСИОНИРАНИ.
--
-- Ревю бележка: сроковете се менят със закона. Ако презапишем
-- реда при промяна, старите задачи изглеждат "сгрешени" в одита.
-- Затова: нов ред за нова версия на правилото (valid_from/valid_to),
-- а не UPDATE върху съществуващ. Само един ред на `code` може да е
-- "текущ" (valid_to is null) — вижте частичния уникален индекс
-- по-долу. Всяка задача пази obligation_type_id към КОНКРЕТНАТА
-- версия, активна при създаването ѝ — историята остава вярна дори
-- след бъдещи законодателни промени.
--
-- deadline_rule конвенция (jsonb) — реалният срок винаги минава
-- допълнително през правилото за пренасяне при почивен ден
-- (чл. 22, ал. 7 ДОПК) в Edge Function-а, срещу таблицата `holidays`
-- по-долу, не тук:
--
--   {"type": "fixed_date", "month": 6, "day": 30}
--   {"type": "day_of_next_month", "day": 25}
--   {"type": "quarter_end_plus",
--    "q1": "04-30", "q2": "07-31", "q3": "10-31", "q4": "01-31"}
--   {"type": "monthly_advance_zkpo_schedule"}
--   {"type": "quarterly_advance_zkpo_schedule"}
--   {"type": "before_activity_start"}
--   {"type": "manual"}
-- ------------------------------------------------------------

create table obligation_types (
  id uuid primary key default gen_random_uuid(),
  code text not null,                      -- 'obr1', 'obr6', 'chl55_dividend', ... (стабилен за целия живот на задължението)
  name text not null,
  trigger_type obligation_trigger not null,
  deadline_rule jsonb not null,
  requires_payment boolean not null default false,
  requires_confirmation_upload boolean not null default true,
  applies_to_all_legal_entities boolean not null default false,
  applies_to_registration_type_id uuid references registration_types(id),
  applies_to_activity_type_id uuid references activity_types(id),
  applies_to_dossier_flag dossier_flag,
  valid_from date not null default current_date,
  valid_to date,                            -- null = текуща версия
  superseded_by uuid references obligation_types(id),
  change_reason text,                       -- защо е нова версия (напр. "промяна на срока в ДВ бр. ...")
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from)
);
-- само една "текуща" версия на всеки code
create unique index idx_obligation_types_current on obligation_types(code) where valid_to is null;
create index idx_obligation_types_code on obligation_types(code);

-- ------------------------------------------------------------
-- Настройки на клиент — кои задължения реално важат (SPEC.md §3)
-- ------------------------------------------------------------

create table client_obligation_settings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  obligation_type_id uuid not null references obligation_types(id),
  enabled boolean not null default true,
  overridden_by_admin boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (client_id, obligation_type_id)
);

-- ------------------------------------------------------------
-- Задачи (SPEC.md §4) — разширен жизнен цикъл.
--
-- Ревю бележки, отразени тук:
--  - идемпотентност: уникален индекс (client_id, obligation_type_id,
--    period_label) — вече го имахме, потвърдено правилно.
--  - assigned_user_id се попълва ЕДНОКРАТНО при създаване (снимка
--    на тогавашния отговорник на клиента) — смяна на отговорник
--    занапред не пренаписва кой е бил длъжен по стари задачи.
--  - not_applicable: за "нулева декларация / не се дължи този
--    период" — затваря без да минава през confirmation cycle.
--  - parent_task_id + parent_link_type: корекции (нова задача,
--    свързана към грешната) и многофазни вериги (напр. майчинство)
--    са отделни СВЪРЗАНИ задачи, не нови статуси на същата.
--  - due_date_extended_from: пази оригиналния срок при удължаване,
--    самото удължаване се одитва в audit_log (кой/защо).
--  - confirmation_status='accepted' от разпознаването на текст НЕ
--    затваря автоматично задачата — само предлага; човек трябва
--    изрично да потвърди (виж SPEC.md §4). completed_by пази кой.
--  - files_generated_detected_* е ПОДСКАЗКА (имената варират), не
--    гаранция — пази и кой файл точно е засечен, за проследимост.
-- ------------------------------------------------------------

create table tasks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  obligation_type_id uuid not null references obligation_types(id),
  period_label text not null,               -- напр. '2026-07', '2026-Q2', '2026'
  period_start date,
  period_end date,
  event_date date,                          -- за trigger_type = 'event'
  assigned_user_id uuid references profiles(id),  -- снимка при създаване, не live връзка
  due_date date not null,                   -- вече изчислен, с пренасяне при почивен ден
  due_date_extended_from date,              -- оригинален срок, ако е бил удължаван (причината — в audit_log)
  status task_status not null default 'waiting',
  not_applicable boolean not null default false,   -- "не се дължи този период"
  not_applicable_reason text,
  parent_task_id uuid references tasks(id),
  parent_link_type task_link_type,
  files_generated_detected_at timestamptz,
  files_generated_detected_path text,       -- кой конкретен файл/път е засечен в Drive
  confirmation_file_id uuid,                -- FK към attachments, добавен по-долу
  confirmation_status confirmation_status not null default 'pending',
  completed_by uuid references profiles(id),   -- кой изрично е потвърдил затварянето
  extracted_turnover numeric(14,2),         -- само за ГДД задачи
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (parent_task_id is null or parent_link_type is not null)
);
create index idx_tasks_client on tasks(client_id);
create index idx_tasks_assigned on tasks(assigned_user_id);
create index idx_tasks_status_due on tasks(status, due_date);
create index idx_tasks_parent on tasks(parent_task_id);
-- пази от дублирано автоматично създаване на един и същ период
create unique index idx_tasks_unique_recurring on tasks(client_id, obligation_type_id, period_label);

-- Болничен: причината е специална категория лична информация по
-- чл. 9 GDPR (SPEC.md §11) — нарочно е ОТДЕЛНА таблица, не колона в
-- tasks, за да може да пазим по-строг достъп/различна retention
-- политика за нея, без да засягаме останалите данни на задачата.
create table task_sick_leave_details (
  task_id uuid primary key references tasks(id) on delete cascade,
  reason text not null,     -- категория, не диагноза/МКБ код — виж SPEC.md §11
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Прикачени файлове
-- ------------------------------------------------------------

create table attachments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  kind attachment_kind not null,
  storage_path text not null,               -- път в частен Supabase Storage bucket
  uploaded_by uuid references profiles(id),
  uploaded_at timestamptz not null default now(),
  recognized_text_excerpt text,             -- откъс от разпознатия текст, за одит
  recognized_marker text,                   -- напр. 'приета' / 'отказана' / null
  recognized_confidence numeric(4,3)        -- 0.000–1.000, ако разпознаването върне увереност
);
create index idx_attachments_task on attachments(task_id);

alter table tasks
  add constraint fk_tasks_confirmation_file
  foreign key (confirmation_file_id) references attachments(id);

alter table client_dossier_info
  add constraint fk_dossier_turnover_task
  foreign key (turnover_source_task_id) references tasks(id);

-- ------------------------------------------------------------
-- Задължения за плащане (SPEC.md §3, §5)
-- ------------------------------------------------------------

create table task_payments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  amount_due numeric(14,2),
  currency text not null default 'BGN',
  due_date date not null,
  paid boolean not null default false,
  paid_at timestamptz,
  proof_attachment_id uuid references attachments(id),
  created_at timestamptz not null default now()
);
create index idx_task_payments_task on task_payments(task_id);
create index idx_task_payments_unpaid on task_payments(paid, due_date) where paid = false;

-- ------------------------------------------------------------
-- Официални празници — за правилото по чл. 22, ал. 7 ДОПК.
--
-- Ревю бележка: без тази таблица "пренасяне при почивен ден" е
-- приблизително, не точно — а размества се с решение на МС всяка
-- година. Поддържа се от admin екран; seed.sql съдържа стартов,
-- добросъвестен опит за 2026 — ЗАДЪЛЖИТЕЛНО се проверява срещу
-- официалното решение на МС/Държавен вестник, не се приема на доверие.
-- ------------------------------------------------------------

create table holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Одит лог — add-only (SPEC.md §11)
-- ------------------------------------------------------------

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,        -- 'client','task','registration','attachment', ...
  entity_id uuid not null,
  action text not null,             -- 'created','updated','status_changed','file_downloaded','due_date_extended', ...
  actor_user_id uuid references profiles(id),
  details jsonb,
  created_at timestamptz not null default now()
);
create index idx_audit_log_entity on audit_log(entity_type, entity_id);

-- ------------------------------------------------------------
-- Лог на изпратени известия — идемпотентен (SPEC.md §5).
--
-- Ревю бележка: ежедневна ескалация ПО ЗАДАЧА при 36 клиента е
-- прекалено много писма — сменено на дневен дайджест до admin
-- (notification_type='escalation_digest', task_id null, details
-- носи списъка) + отделни незабавни писма само за критичното
-- (отказ от НАП, срок днес). Уникалният индекс пази от двойно
-- изпращане при повторно изпълнение на крона.
-- ------------------------------------------------------------

create table notification_log (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references tasks(id) on delete cascade,
  payment_id uuid references task_payments(id) on delete cascade,
  notification_type text not null,  -- 'opened','reminder_t5','reminder_t1','due_today','escalation_digest','payment_reminder','payment_escalation','rejection_alert'
  notification_date date not null default current_date,   -- за дедупликация по календарен ден (Europe/Sofia)
  sent_to uuid references profiles(id),
  status text not null default 'sent' check (status in ('sent', 'failed', 'pending')),
  error text,
  details jsonb,                     -- напр. списък task_id-та за дайджест
  sent_at timestamptz not null default now()
);
create unique index idx_notification_log_dedupe
  on notification_log(coalesce(task_id, '00000000-0000-0000-0000-000000000000'::uuid), notification_type, notification_date, sent_to);

-- ------------------------------------------------------------
-- Heartbeat на крона — кой наблюдава дали крона изобщо се е
-- изпълнил (SPEC.md §5). Външен monitor (извън тази система, отделен
-- канал за аларма) следи дали тук пристига ред всеки ден.
-- ------------------------------------------------------------

create table cron_heartbeats (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,           -- 'daily_task_generation', 'daily_notifications', 'drive_scan', ...
  ran_at timestamptz not null default now(),
  status text not null default 'ok' check (status in ('ok', 'error')),
  details text
);
create index idx_cron_heartbeats_job on cron_heartbeats(job_name, ran_at desc);

-- ------------------------------------------------------------
-- RLS — включено навсякъде още сега (fail-closed).
-- Политиките се дефинират в 0002_rls_policies.sql.
-- ------------------------------------------------------------

alter table profiles enable row level security;
alter table clients enable row level security;
alter table client_registrations enable row level security;
alter table client_activities enable row level security;
alter table client_dossier_flags enable row level security;
alter table client_dossier_info enable row level security;
alter table client_obligation_settings enable row level security;
alter table tasks enable row level security;
alter table task_sick_leave_details enable row level security;
alter table attachments enable row level security;
alter table task_payments enable row level security;
alter table holidays enable row level security;
alter table audit_log enable row level security;
alter table notification_log enable row level security;
alter table cron_heartbeats enable row level security;
