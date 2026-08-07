-- ============================================================
-- Органайзер — начална схема (Supabase / Postgres)
-- Мехов Консулт — проследяване на нормативни срокове.
-- Виж ../../SPEC.md за пълния модел, обосновка и каталог на
-- задълженията. Тази миграция покрива Прогрес #1 и #2 от SPEC.md.
--
-- RLS политиките са само включени (fail-closed) тук — конкретните
-- политики идват в отделна миграция (Прогрес #9 — Сигурност),
-- за да няма прозорец без защита между тази стъпка и следващата.
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

-- ------------------------------------------------------------
-- Потребители
-- auth.users идва от Supabase Auth; тук само разширяващ профил.
-- Акаунти се създават само от admin (виж SPEC.md §2) — без
-- публична регистрация, затова няма отделен "signup" механизъм тук.
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
  created_at timestamptz not null default now(),
  unique (client_id, activity_type_id)
);

-- ------------------------------------------------------------
-- Досие на клиента (СОЛ / ТД / ГД + оборот) — SPEC.md §3
-- ------------------------------------------------------------

create table client_dossiers (
  client_id uuid primary key references clients(id) on delete cascade,
  has_sol boolean not null default false,   -- самоосигуряващо се лице
  has_td boolean not null default false,    -- трудов договор
  has_gd boolean not null default false,    -- граждански договор
  last_known_turnover numeric(14,2),
  turnover_source_task_id uuid,             -- FK добавен по-долу, след create table tasks
  turnover_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Видове задължения (шаблони) — SPEC.md §3, §6
--
-- deadline_rule конвенция (jsonb), изчислен на реален срок винаги
-- минава допълнително през правилото за пренасяне при почивен ден
-- (чл. 22, ал. 7 ДОПК) в Edge Function-а, не тук:
--
--   {"type": "fixed_date", "month": 6, "day": 30}
--     — фиксирана календарна дата всяка година
--   {"type": "day_of_next_month", "day": 25}
--     — N-то число на месеца, следващ периода/събитието
--   {"type": "quarter_end_plus",
--    "q1": "04-30", "q2": "07-31", "q3": "10-31", "q4": "01-31"}
--     — тримесечен цикъл (чл. 55 дивиденти/наеми)
--   {"type": "monthly_advance_zkpo_schedule"}
--   {"type": "quarterly_advance_zkpo_schedule"}
--     — специални графици по чл. 84/85 ЗКПО, вижте SPEC.md §6.1
--   {"type": "before_activity_start"}
--     — еднократно, преди начало на дейността (напр. ЕСТИ регистрация)
--   {"type": "manual"}
--     — без фиксиран срок, отваря се и се следи ръчно (напр. чл. 88 ЗКПО)
-- ------------------------------------------------------------

create table obligation_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,               -- 'obr1', 'obr6', 'chl55_dividend', ...
  name text not null,
  trigger_type obligation_trigger not null,
  deadline_rule jsonb not null,
  requires_payment boolean not null default false,
  requires_confirmation_upload boolean not null default true,
  -- приложимост — нула, едно или комбинация от следните определя
  -- към кои клиенти важи; логиката за предложение по подразбиране
  -- в настройките на клиента (§3 "Настройки на клиент") ги комбинира
  applies_to_all_legal_entities boolean not null default false,
  applies_to_registration_type_id uuid references registration_types(id),
  applies_to_activity_type_id uuid references activity_types(id),
  applies_to_dossier_flag text check (applies_to_dossier_flag in ('sol', 'td', 'gd')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

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
-- Задачи (SPEC.md §4)
-- ------------------------------------------------------------

create table tasks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  obligation_type_id uuid not null references obligation_types(id),
  period_label text not null,               -- напр. '2026-07', '2026-Q2', '2026'
  period_start date,
  period_end date,
  event_date date,                          -- за trigger_type = 'event' (напр. дата на решение за дивидент)
  assigned_user_id uuid references profiles(id),  -- наследено от clients.responsible_user_id при създаване
  due_date date not null,                   -- вече изчислен, с пренасяне при почивен ден
  status task_status not null default 'waiting',
  files_generated_detected_at timestamptz,  -- кога Drive проверката (Прогрес #10) е открила генерираните файлове
  confirmation_file_id uuid,                -- FK към attachments, добавен по-долу
  confirmation_status confirmation_status not null default 'pending',
  extracted_turnover numeric(14,2),         -- само за ГДД задачи
  sick_leave_reason text,                   -- само за болнични
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index idx_tasks_client on tasks(client_id);
create index idx_tasks_assigned on tasks(assigned_user_id);
create index idx_tasks_status_due on tasks(status, due_date);
-- пази от дублирано автоматично създаване на един и същ период
create unique index idx_tasks_unique_recurring on tasks(client_id, obligation_type_id, period_label);

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
  recognized_marker text                    -- напр. 'приета' / 'отказана' / null
);
create index idx_attachments_task on attachments(task_id);

alter table tasks
  add constraint fk_tasks_confirmation_file
  foreign key (confirmation_file_id) references attachments(id);

alter table client_dossiers
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
-- Одит лог — add-only (SPEC.md §11)
-- ------------------------------------------------------------

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,        -- 'client','task','registration','attachment', ...
  entity_id uuid not null,
  action text not null,             -- 'created','updated','status_changed','file_downloaded', ...
  actor_user_id uuid references profiles(id),
  details jsonb,
  created_at timestamptz not null default now()
);
create index idx_audit_log_entity on audit_log(entity_type, entity_id);

-- ------------------------------------------------------------
-- Лог на изпратени известия — за да не дублираме имейли (SPEC.md §5)
-- ------------------------------------------------------------

create table notification_log (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references tasks(id) on delete cascade,
  payment_id uuid references task_payments(id) on delete cascade,
  notification_type text not null,  -- 'opened','reminder_t5','reminder_t1','due_today','escalation_daily','payment_reminder','payment_escalation','rejection_alert'
  sent_to uuid references profiles(id),
  sent_at timestamptz not null default now()
);
create index idx_notification_log_task on notification_log(task_id, notification_type, sent_at);

-- ------------------------------------------------------------
-- RLS — включено навсякъде още сега (fail-closed).
-- Политиките се дефинират в следваща миграция (Прогрес #9).
-- Без политики никой (освен service_role) не вижда нищо — нарочно.
-- ------------------------------------------------------------

alter table profiles enable row level security;
alter table clients enable row level security;
alter table client_registrations enable row level security;
alter table client_activities enable row level security;
alter table client_dossiers enable row level security;
alter table client_obligation_settings enable row level security;
alter table tasks enable row level security;
alter table attachments enable row level security;
alter table task_payments enable row level security;
alter table audit_log enable row level security;
alter table notification_log enable row level security;
