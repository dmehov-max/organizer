-- ============================================================
-- Органайзер — „Плащаме ДДС“ и „Плащаме осигуровки“ като две отделни
-- отметки в досието (поискано изрично 2026-11-14). Досега беше една
-- обща — clients.office_pays_obligations (0064) — и нямаше как да се
-- отбележи фирма, за която офисът превежда осигуровките, но ДДС-то
-- клиентът си плаща сам (или обратното).
--
-- Кое задължение по кой флаг (officePaysFor() в index.html и в
-- generate-tasks):
--   vat_declaration                         → office_pays_vat
--   obr1, obr6_monthly, sol_obr6_annual     → office_pays_contributions
--   останалите с плащане (ГДД, чл. 55, местни данъци, патент,
--   туристически данък)                     → office_pays_obligations
--
-- office_pays_obligations остава, но вече = ДДС ИЛИ осигуровки (през
-- тригера по-долу), т.е. „плащаме нещо за тази фирма“. Не е generated
-- колона нарочно: стар отворен index.html в нечий браузър още пише в
-- нея — тригерът превежда такъв запис в двете нови отметки, вместо
-- да гърми.
--
-- Данни: досегашните 15 фирми с office_pays_obligations = true
-- получават и двете отметки — нищо не се променя, докато Додо не ги
-- прегледа.
-- ============================================================

alter table clients
  add column office_pays_vat boolean not null default false,
  add column office_pays_contributions boolean not null default false;

update clients
set office_pays_vat = office_pays_obligations,
    office_pays_contributions = office_pays_obligations;

create or replace function clients_sync_office_pays() returns trigger
language plpgsql set search_path = public as $$
begin
  -- Стар клиент (само office_pays_obligations се сменя) → и двете.
  if tg_op = 'UPDATE'
     and new.office_pays_obligations is distinct from old.office_pays_obligations
     and new.office_pays_vat = old.office_pays_vat
     and new.office_pays_contributions = old.office_pays_contributions then
    new.office_pays_vat := new.office_pays_obligations;
    new.office_pays_contributions := new.office_pays_obligations;
  end if;
  new.office_pays_obligations := new.office_pays_vat or new.office_pays_contributions;
  return new;
end $$;

-- Само за тригера — не е rpc (виж 0080).
revoke all on function clients_sync_office_pays() from public, anon, authenticated;

create trigger trg_clients_sync_office_pays
  before insert or update on clients
  for each row execute function clients_sync_office_pays();
