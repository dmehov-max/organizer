-- ============================================================
-- Органайзер — таб „Документи от клиенти“ (поискано изрично
-- 2026-10-30): екипът чете писмата и отговорите за своите клиенти.
--
-- Същото правило като Проверки и Осчетоводяване: is_client_owner.
-- Записът остава само за service_role. Токените от линковете в
-- писмата не се дават на браузъра, затова правото върху
-- client_document_status е по колони.
-- ============================================================

create policy client_reminders_select on client_reminders
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

create policy client_reminder_replies_select on client_reminder_replies
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

create policy client_document_status_select on client_document_status
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

revoke select on client_document_status from authenticated, anon;
grant select (id, client_id, period_label, mode, received_at, response, responded_at)
  on client_document_status to authenticated;
