-- ============================================================
-- Органайзер — начални справочни данни (каталогът от SPEC.md §6)
-- Изпълнява се след 0001_init.sql.
-- ============================================================

-- ------------------------------------------------------------
-- Регистрации (описателни; ДДС не поражда задачи тук — Controlisy
-- вече го следи, виж SPEC.md §1)
-- ------------------------------------------------------------

insert into registration_types (code, name) values
  ('vat', 'ДДС регистрация'),
  ('insurer', 'Регистрация като осигурител');

-- ------------------------------------------------------------
-- Дейности
-- ------------------------------------------------------------

insert into activity_types (code, name) values
  ('general', 'Обичайна търговска/консултантска дейност'),
  ('rental', 'Отдаване под наем'),
  ('patent', 'Патентна дейност'),
  ('tourism_accommodation', 'Краткосрочно отдаване под наем / туристическо настаняване');

-- ------------------------------------------------------------
-- Видове задължения — 6.1 Автоматично повтарящи се
-- ------------------------------------------------------------

insert into obligation_types
  (code, name, trigger_type, deadline_rule, requires_payment, applies_to_all_legal_entities, applies_to_dossier_flag)
values
  ('obr1', 'Декл. обр. 1 (Наредба Н-8)', 'recurring',
    '{"type":"day_of_next_month","day":25}', true, false, 'td'),
  ('obr6_monthly', 'Декл. обр. 6 (Наредба Н-8)', 'recurring',
    '{"type":"day_of_next_month","day":25}', true, false, 'td'),
  ('zkpo_advance_monthly', 'Авансови вноски ЗКПО — месечни (прих. >3 млн лв.)', 'recurring',
    '{"type":"monthly_advance_zkpo_schedule"}', true, true, null),
  ('zkpo_advance_quarterly', 'Авансови вноски ЗКПО — тримесечни', 'recurring',
    '{"type":"quarterly_advance_zkpo_schedule"}', true, true, null),
  ('zkpo_87a', 'Декл. чл. 87а ЗКПО — вид и размер на авансовите вноски', 'recurring',
    '{"type":"fixed_date","month":4,"day":15}', false, true, null),
  ('patent_declaration', 'Патентна декларация + I тримесечие вноска', 'recurring',
    '{"type":"fixed_date","month":1,"day":31}', true, false, null),
  ('sol_obr1_5', 'Обр. 1 и Обр. 5 за самоосигуряващи се (избор)', 'recurring',
    '{"type":"fixed_date","month":2,"day":25}', false, false, 'sol'),
  ('chl73_al1', 'Справка чл. 73, ал. 1 ЗДДФЛ — доходи извън трудови правоотношения (ГД, наеми и др.)', 'recurring',
    '{"type":"fixed_date","month":2,"day":28}', false, false, 'gd'),
  ('chl73_al6', 'Справка чл. 73, ал. 6 ЗДДФЛ — доходи от трудови правоотношения (ТД)', 'recurring',
    '{"type":"fixed_date","month":2,"day":28}', false, false, 'td'),
  ('sol_obr6_annual', 'Годишен Обр. 6 за самоосигуряващи се (изравняване)', 'recurring',
    '{"type":"fixed_date","month":4,"day":30}', true, false, 'sol'),
  ('local_taxes', 'Местни данъци (имот + МПС), 5% отстъпка', 'recurring',
    '{"type":"fixed_date","month":4,"day":30}', true, true, null),
  ('gdd_individuals', 'ГДД физически лица', 'recurring',
    '{"type":"fixed_date","month":4,"day":30}', true, false, null),
  ('gdd_zkpo_92', 'ГДД ЗКПО (чл. 92) + плащане', 'recurring',
    '{"type":"fixed_date","month":6,"day":30}', true, true, null),
  ('gfo_or_chl38', 'Публикуване на ГФО / декл. чл. 38, ал. 9, т. 2 ЗСч (при липса на дейност) в Търговски регистър', 'recurring',
    '{"type":"fixed_date","month":9,"day":30,"note":"отделно от ГДД по чл.92 (30 юни) — потвърдено на живо, чл. 38 ЗСч"}', false, true, null),
  ('god_nsi', 'ГОД пред НСИ (индивидуален отчет)', 'recurring',
    '{"type":"fixed_date","month":6,"day":30}', false, true, null),
  ('gdd_chl50_et', 'ГДД по чл. 50 ЗДДФЛ за ЕТ', 'recurring',
    '{"type":"fixed_date","month":6,"day":30}', true, false, null),
  ('god_nsi_consolidated', 'ГОД пред НСИ — консолидиран отчет (ако е приложимо)', 'recurring',
    '{"type":"fixed_date","month":9,"day":30}', false, false, null);

-- ------------------------------------------------------------
-- Видове задължения — 6.2 Задействани по събитие
-- ------------------------------------------------------------

insert into obligation_types
  (code, name, trigger_type, deadline_rule, requires_payment, applies_to_all_legal_entities, applies_to_dossier_flag)
values
  ('chl55_dividend', 'Данък при източника за дивиденти (чл. 55)', 'event',
    '{"type":"quarter_end_plus","q1":"04-30","q2":"07-31","q3":"10-31","q4":"01-31"}', true, false, null),
  ('chl55_rental', 'Данък при източника за доходи от наем (чл. 55)', 'event',
    '{"type":"quarter_end_plus","q1":"04-30","q2":"07-31","q3":"10-31","q4":"01-31"}', true, false, null),
  ('zkpo_88', 'Декл. чл. 88 ЗКПО — промяна на авансови вноски', 'event',
    '{"type":"manual"}', false, true, null),
  ('sick_leave', 'Болничен лист — подаване на данни към НОИ (Прил. №9)', 'event',
    '{"type":"day_of_next_month","day":10}', false, false, 'td'),
  ('maternity', 'Майчинство — обезщетение бременност/раждане/отглеждане', 'event',
    '{"type":"manual","note":"многофазно — подсрокове в уточняване"}', false, false, 'td');

-- ------------------------------------------------------------
-- Видове задължения — 6.3 По дейност: туристическо настаняване
-- ------------------------------------------------------------

insert into obligation_types
  (code, name, trigger_type, deadline_rule, requires_payment, applies_to_activity_type_id)
select
  v.code, v.name, v.trigger_type::obligation_trigger, v.deadline_rule::jsonb, v.requires_payment,
  (select id from activity_types where code = 'tourism_accommodation')
from (values
  ('esti_registration', 'Регистрация на обекта в ЕСТИ', 'activity', '{"type":"before_activity_start"}', false),
  ('esti_monthly_report', 'Справка в ЕСТИ за туристическия данък', 'activity', '{"type":"day_of_next_month","day":7}', false),
  ('tourist_tax', 'Туристически данък — внасяне в общината', 'activity', '{"type":"day_of_next_month","day":15}', true),
  ('chl61r', 'Годишна декл. чл. 61р, ал. 5 ЗМДТ', 'activity', '{"type":"fixed_date","month":1,"day":30,"note":"потвърдено на живо — 30 януари, не 31"}', false)
) as v(code, name, trigger_type, deadline_rule, requires_payment);

-- ------------------------------------------------------------
-- Официални празници 2026 — ДОБРОСЪВЕСТЕН СТАРТОВ ОПИТ, НЕ Е
-- ОКОНЧАТЕЛЕН. Пренасяните почивни дни (когато празник се пада в
-- събота/неделя) се определят с решение на Министерски съвет всяка
-- година — виж SPEC.md §5. ЗАДЪЛЖИТЕЛНО провери срещу официалното
-- решение на МС / Държавен вестник, преди да разчиташ на този
-- списък за реални срокове. Поддържа се занапред от admin екран.
-- ------------------------------------------------------------

insert into holidays (holiday_date, name) values
  ('2026-01-01', 'Нова година'),
  ('2026-01-02', 'Допълнителен почивен ден (еднократно решение на МС)'),
  ('2026-03-03', 'Ден на Освобождението на България'),
  ('2026-04-10', 'Велики петък'),
  ('2026-04-11', 'Велика събота'),
  ('2026-04-12', 'Великден'),
  ('2026-04-13', 'Велики понеделник'),
  ('2026-05-01', 'Ден на труда'),
  ('2026-05-06', 'Гергьовден / Ден на храбростта'),
  ('2026-05-24', 'Ден на българската просвета и култура'),
  ('2026-09-06', 'Ден на Съединението'),
  ('2026-09-22', 'Ден на Независимостта на България'),
  ('2026-12-24', 'Бъдни вечер'),
  ('2026-12-25', 'Коледа'),
  ('2026-12-26', 'Коледа (втори ден)');
