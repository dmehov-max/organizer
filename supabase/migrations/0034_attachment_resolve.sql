-- ============================================================
-- Органайзер — позволява админ/отговорник да "разреши" (потвърди
-- ръчно) предупреждение за грешна фирма/дублиран номер директно от
-- приложението, вместо през SQL всеки път. Досега attachments
-- нямаше UPDATE политика изобщо — само service_role (Edge Function/
-- SQL Editor) можеше да пипа тези флагове.
--
-- Плюс: пазим ЕИК-а, извлечен от самия документ, за да може
-- предупреждението да показва "документът казва X, клиентът е Y"
-- директно на екрана, вместо да трябва да се диагностицира ръчно.
-- ============================================================

alter table attachments
  add column recognized_declared_eik text;

create policy attachments_update on attachments
  for update to authenticated
  using (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid())
  )
  with check (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid())
  );
