-- ============================================================
-- Органайзер — сметки в чужбина и годишният отчет към БНБ.
-- Заявено от Дойчин, 2026-11-07.
--
-- Основание: Наредба № 27 на БНБ (ред. ДВ бр. 30/2026, в сила от
-- 01.04.2026):
--   * чл. 6, ал. 1, т. 2 — декларация (СПБ-2) при откриване на сметка
--     в чужбина, вкл. при платежни институции и ДЕП — 15 работни дни;
--   * чл. 8, ал. 2 — уведомление при закриване — 15 работни дни;
--   * чл. 9, ал. 4, т. 3 — ГОДИШЕН отчет, ако общият ОСТАТЪК (салдо, не
--     оборот) по всички такива сметки към 31.12 е >= 25 000 евро;
--   * чл. 12, ал. 4 — срок 25 януари на следващата година.
--
-- 1) Таблица client_foreign_accounts — коя фирма къде има сметка,
--    кога е открита/закрита и подадена ли е СПБ-2.
-- 2) foreign_account_balances — салдото към 31.12 по сметка и година
--    (попълва се в началото на януари от извлеченията за декември).
-- 3) Задължение bnb_foreign_accounts_annual — задача за всяка фирма с
--    флаг foreign_accounts, срок 25.01, период = предходната година.
--    Под прага задачата се маркира „неприложимо“ с причина (сборът).
--
-- Само схема и каталог — клиентски данни НЕ влизат в репото
-- (hygiene.test.ts); кои фирми имат сметки се попълва отделно.
-- ============================================================

create table client_foreign_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  provider text not null,              -- напр. 'myPOS Ltd (IE)', 'Paysera (LT)'
  iban text,
  currency text not null default 'EUR',
  opened_on date,
  closed_on date,
  spb2_filed_on date,                  -- дата на подадената СПБ-2
  spb2_reference text,                 -- входящ номер от БНБ
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_foreign_accounts_client on client_foreign_accounts(client_id);

create table foreign_account_balances (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references client_foreign_accounts(id) on delete cascade,
  balance_date date not null,          -- обикновено 31.12.ГГГГ
  balance numeric(14,2) not null,      -- във валутата на сметката
  balance_eur numeric(14,2) not null,  -- по курса на БНБ към balance_date
  source text,                         -- откъде е взето (извлечение/файл)
  created_at timestamptz not null default now(),
  unique (account_id, balance_date)
);

alter table client_foreign_accounts enable row level security;
alter table foreign_account_balances enable row level security;

create policy client_foreign_accounts_select on client_foreign_accounts
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));
create policy client_foreign_accounts_admin_write on client_foreign_accounts
  for all to authenticated
  using (is_admin())
  with check (is_admin());

create policy foreign_account_balances_select on foreign_account_balances
  for select to authenticated
  using (is_admin() or exists (
    select 1 from client_foreign_accounts a
    where a.id = account_id and is_client_owner(a.client_id)));
create policy foreign_account_balances_admin_write on foreign_account_balances
  for all to authenticated
  using (is_admin())
  with check (is_admin());

-- Сбор на салдата в евро по фирма и дата — за решението „над/под прага“.
create view client_foreign_balance_totals with (security_invoker = true) as
select a.client_id, b.balance_date,
       sum(b.balance_eur) as total_eur,
       count(*) as accounts,
       sum(b.balance_eur) >= 25000 as report_required
from foreign_account_balances b
join client_foreign_accounts a on a.id = b.account_id
group by a.client_id, b.balance_date;

insert into obligation_types
  (code, name, trigger_type, deadline_rule, requires_payment, applies_to_dossier_flag)
values
  ('bnb_foreign_accounts_annual',
   'БНБ — годишен отчет за сметки в чужбина (чл. 9, ал. 4, т. 3 Наредба 27), ако салдото към 31.12 ≥ 25 000 €',
   'recurring',
   '{"type":"fixed_date","day":25,"month":1,"year_offset":-1,"note":"само при общ остатък ≥ 25 000 € към 31.12; иначе — неприложимо"}'::jsonb,
   false, 'foreign_accounts');
