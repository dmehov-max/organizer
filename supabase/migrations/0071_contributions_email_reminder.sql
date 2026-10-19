-- ============================================================
-- Органайзер — ново месечно задължение "Имейли за дължими вноски"
-- (поискано изрично 2026-10-19): всеки месец до 20-то число
-- счетоводителят праща на клиента имейл с дължимите вноски
-- (осигуровки/ДДС и пр.) за предходния месец — преди реалните
-- срокове за плащане (25-то).
--
-- Само задача в таблото — системата НЕ праща имейла сама;
-- счетоводителят го праща и маркира задачата като готова.
--
-- Важи за ВСИЧКИ активни клиенти (applies_to_all_legal_entities —
-- към днешна дата всички 35 клиента са legal_entity). Без плащане и
-- без качване на потвърждение. Период = предходния месец (както при
-- обр.1), срок = 20-то на текущия месец (day_of_next_month).
--
-- Пусни само ВЕДНЪЖ (не е идемпотентна — втори пуск ще гръмне на
-- idx_obligation_types_current, което е желаното поведение).
-- ============================================================

insert into obligation_types (
  code, name, trigger_type, deadline_rule, requires_payment,
  requires_confirmation_upload, applies_to_all_legal_entities, change_reason
) values (
  'contributions_email', 'Имейли за дължими вноски', 'recurring',
  '{"type":"day_of_next_month","day":20}', false,
  false, true,
  'Ново задължение — имейл до клиента с дължимите вноски до 20-то число'
);

-- Backfill — иначе client_obligation_settings няма ред за новия вид
-- и generate-tasks не създава задачи за съществуващите клиенти.
do $$
declare
  c record;
begin
  for c in select id from clients loop
    perform recompute_client_obligations(c.id);
  end loop;
end $$;
