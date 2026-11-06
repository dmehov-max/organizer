-- ============================================================
-- Органайзер — банкови папки в Controlisy (06.11.2026, продължение
-- на 0079). Поискано: „покупки, продажби и банка“.
--
-- В Controlisy фирмата има една или НЯКОЛКО банкови папки
-- („03-Банка“, „03-Банка Mypos“, „04- Банка Прокредит“, при една
-- фирма 13 сметки). Затова не е една колона, а списък с етикет:
--   [{ "label": "03-Банка Mypos", "email": "docs+…@controlisy.bg" }, …]
-- При качване клиентът избира „Банково извлечение“ и, ако банките
-- са повече от една, коя; incoming_documents.bank_label пази избора.
--
-- Адресите се вземат от Controlisy (папка → Специални разрешения →
-- Получаване по имейл). Самите стойности са клиентски данни и НЕ са
-- в репото — въведени са директно в базата.
-- ============================================================

alter table clients
  add column controlisy_bank_folders jsonb not null default '[]'::jsonb
    check (jsonb_typeof(controlisy_bank_folders) = 'array');

alter table incoming_documents
  drop constraint if exists incoming_documents_kind_check,
  add constraint incoming_documents_kind_check check (kind in ('purchase', 'sale', 'bank')),
  add column bank_label text;
