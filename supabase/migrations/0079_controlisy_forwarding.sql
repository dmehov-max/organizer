-- ============================================================
-- Органайзер — препращане на качените от клиента документи към
-- Controlisy (поискано 2026-11-06, тест със Скрийн бокс ООД).
--
-- Идея: клиентът качва през своя линк (upload.html, 0059), ние знаем
-- кой какво е пратил, а Органайзерът сам праща файла по имейл на
-- уникалния адрес на папката на фирмата в Controlisy ("имейл към
-- папка", вид docs+<код>@controlisy.bg). Controlisy остава само място
-- за осчетоводяване; не зависим от техен API за четене.
--
-- Две папки на фирма (Покупки / Продажби) → два адреса. Ако е
-- попълнен само единият, всичко отива там. Ако са и двата, клиентът
-- избира вид при качване (incoming_documents.kind).
-- ============================================================

alter table clients
  add column controlisy_purchases_email text,
  add column controlisy_sales_email text;

alter table incoming_documents
  add column kind text check (kind in ('purchase', 'sale')),
  add column forwarded_at timestamptz,
  add column forwarded_to text,
  add column forward_error text;
