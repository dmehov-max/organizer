-- ============================================================
-- Органайзер — имейли на клиента + "засечено по имейл" източник за
-- incoming_documents (поискано 2026-08-23, продължение на 0059).
--
-- Проблем: освен линка за самостоятелно качване (0059), клиентите
-- продължават да пращат документи направо по имейл на счетоводителя
-- — и точно това се губи. Решение: всеки клиент пази списък свои
-- имейл адреси (contact_emails); при "проверка на пощата" (в момента
-- РЪЧНО извикване в чат сесия с Клод — виж бележката в upload-document/
-- README.md, истинска фонова автоматизация е бъдеща стъпка) —
-- напасва подателя към клиент и логва находката тук, БЕЗ да мести
-- самия файл (storage_path остава null, source_url сочи към
-- писмото в Gmail) — счетоводителят отваря писмото ръчно и решава.
-- ============================================================

alter table clients add column contact_emails text[] not null default '{}';
create index idx_clients_contact_emails on clients using gin (contact_emails);

alter table incoming_documents alter column storage_path drop not null;
alter table incoming_documents add column source text not null default 'client_upload'
  check (source in ('client_upload', 'email_detected'));
alter table incoming_documents add column source_url text;   -- Gmail permalink, само за source='email_detected'

alter table incoming_documents add constraint incoming_documents_has_content
  check (storage_path is not null or source_url is not null);
