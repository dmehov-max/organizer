-- ============================================================
-- Органайзер — заключване на функциите, които PostgREST излага като
-- /rest/v1/rpc/<име> (преглед на сигурността, 06.11.2026; Supabase
-- security advisor: anon_security_definer_function_executable,
-- function_search_path_mutable).
--
-- Проблемът: всяка функция в public с EXECUTE за anon/authenticated е
-- достъпна през REST с публичния ключ. Повечето ни са безобидни
-- (четат само auth.uid()), но recompute_client_obligations(uuid) ПИШЕ
-- в client_obligation_settings — всеки с публичния ключ можеше да
-- размести кои задължения важат за клиент.
--
-- Какво НЕ пипаме и защо:
--  - is_admin() / is_active() / is_client_owner(uuid) и помощните
--    attachment_task_id / inspection_client_id / incoming_doc_client_id
--    се ползват в RLS политики (17/62/27 политики за първите три).
--    Изразът на политиката се изпълнява като ролята на заявката
--    (authenticated), т.е. authenticated ТРЯБВА да има EXECUTE, иначе
--    всяка заявка към tasks/clients/... пада с permission denied.
--    Махаме само anon и PUBLIC — anon няма нито една политика и няма
--    какво да прави с тях. Нито index.html, нито Edge Functions ги
--    викат през rpc (проверено с grep за ".rpc(").
--  - тригерните функции (trg_sync_*) не могат да се викат през rpc
--    смислено (връщат trigger), но EXECUTE им се маха от всички
--    освен postgres/service_role за чистота. Тригерът продължава да
--    работи: EXECUTE се проверява при CREATE TRIGGER, не при
--    изпълнение, а функциите са SECURITY DEFINER с owner postgres.
--  - recompute_client_obligations се вика само от тригерите (като
--    postgres) и от миграции — нищо отвън. Махаме anon, authenticated
--    и PUBLIC.
--
-- search_path: трите помощни функции за Storage политиките нямаха
-- фиксиран search_path (advisor WARN). Фиксираме го, без да пипаме
-- тялото им.
--
-- Идемпотентна — REVOKE/ALTER може да се пуснат повторно.
-- ============================================================

-- 1. Пишещата функция и тригерните — само postgres/service_role.
revoke execute on function public.recompute_client_obligations(uuid) from public, anon, authenticated;
revoke execute on function public.trg_sync_obligations_from_row() from public, anon, authenticated;
revoke execute on function public.trg_sync_obligations_on_client_insert() from public, anon, authenticated;

-- 2. Помощните за RLS — без anon/PUBLIC, authenticated остава (виж горе).
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_active() from public, anon;
revoke execute on function public.is_client_owner(uuid) from public, anon;
revoke execute on function public.attachment_task_id(text) from public, anon;
revoke execute on function public.inspection_client_id(text) from public, anon;
revoke execute on function public.incoming_doc_client_id(text) from public, anon;

-- 3. Фиксиран search_path за Storage помощните.
alter function public.attachment_task_id(text) set search_path = public;
alter function public.inspection_client_id(text) set search_path = public;
alter function public.incoming_doc_client_id(text) set search_path = public;
