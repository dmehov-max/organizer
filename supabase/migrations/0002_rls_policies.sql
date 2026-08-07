-- ============================================================
-- Органайзер — RLS политики (SPEC.md §11)
--
-- Принцип: admin вижда/управлява всичко; счетоводител вижда само
-- клиентите, за които е отговорник (clients.responsible_user_id),
-- и задачите, възложени на него (tasks.assigned_user_id) — виж
-- SPEC.md §2 и §3. service_role (Edge Functions) заобикаля RLS по
-- дизайн на Supabase — там минава cron генерирането на задачи,
-- изпращането на известия и Drive проверката.
-- ============================================================

create or replace function is_admin()
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'admin' and active
  );
$$;

create or replace function is_client_owner(target_client_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from clients
    where id = target_client_id and responsible_user_id = auth.uid()
  );
$$;

-- ------------------------------------------------------------
-- profiles
-- ------------------------------------------------------------

create policy profiles_select on profiles
  for select to authenticated
  using (is_admin() or id = auth.uid());

create policy profiles_admin_write on profiles
  for all to authenticated
  using (is_admin())
  with check (is_admin());

-- ------------------------------------------------------------
-- clients — счетоводител вижда само своите; управлява само admin
-- ------------------------------------------------------------

create policy clients_select on clients
  for select to authenticated
  using (is_admin() or responsible_user_id = auth.uid());

create policy clients_admin_write on clients
  for insert to authenticated
  with check (is_admin());

create policy clients_admin_update on clients
  for update to authenticated
  using (is_admin())
  with check (is_admin());

create policy clients_admin_delete on clients
  for delete to authenticated
  using (is_admin());

-- ------------------------------------------------------------
-- client_registrations / client_activities / client_dossiers /
-- client_obligation_settings — видимост следва clients, редакция
-- само admin (счетоводителят чете, не пипа регистрационния статус)
-- ------------------------------------------------------------

create policy client_registrations_select on client_registrations
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

create policy client_registrations_admin_write on client_registrations
  for all to authenticated
  using (is_admin())
  with check (is_admin());

create policy client_activities_select on client_activities
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

create policy client_activities_admin_write on client_activities
  for all to authenticated
  using (is_admin())
  with check (is_admin());

create policy client_dossier_flags_select on client_dossier_flags
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

create policy client_dossier_flags_admin_write on client_dossier_flags
  for all to authenticated
  using (is_admin())
  with check (is_admin());

create policy client_dossier_info_select on client_dossier_info
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

create policy client_dossier_info_admin_write on client_dossier_info
  for all to authenticated
  using (is_admin())
  with check (is_admin());

create policy client_obligation_settings_select on client_obligation_settings
  for select to authenticated
  using (is_admin() or is_client_owner(client_id));

create policy client_obligation_settings_admin_write on client_obligation_settings
  for all to authenticated
  using (is_admin())
  with check (is_admin());

-- ------------------------------------------------------------
-- tasks — счетоводителят вижда/обновява само възложените си задачи;
-- вкл. ръчно създаване за задължения тип 'event' на собствен клиент
-- (SPEC.md §4 — дивидент/наем/болничен и др.)
-- ------------------------------------------------------------

create policy tasks_select on tasks
  for select to authenticated
  using (is_admin() or assigned_user_id = auth.uid());

create policy tasks_insert on tasks
  for insert to authenticated
  with check (
    is_admin()
    or (assigned_user_id = auth.uid() and is_client_owner(client_id))
  );

create policy tasks_update on tasks
  for update to authenticated
  using (is_admin() or assigned_user_id = auth.uid())
  with check (is_admin() or assigned_user_id = auth.uid());
  -- Забележка: пренасочване към друг служител (смяна на
  -- assigned_user_id) остава по конвенция admin действие — RLS
  -- позволява технически и на счетоводителя да го смени за своя
  -- задача; ако трябва твърдо ограничение по колона, добавяме
  -- отделен trigger по-късно (не е приоритет за 3-4 потребителя).

create policy tasks_admin_delete on tasks
  for delete to authenticated
  using (is_admin());

-- ------------------------------------------------------------
-- task_sick_leave_details — специална категория данни (GDPR чл. 9,
-- SPEC.md §11). Нарочно същият кръг достъп като tasks (не по-широк),
-- изолацията в отделна таблица е за по-лесна отделна retention/
-- изтриване политика занапред, не за различни права още сега.
-- ------------------------------------------------------------

create policy task_sick_leave_select on task_sick_leave_details
  for select to authenticated
  using (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid())
  );

create policy task_sick_leave_write on task_sick_leave_details
  for all to authenticated
  using (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid())
  )
  with check (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid())
  );

-- ------------------------------------------------------------
-- attachments — качване/преглед само от отговорника на задачата;
-- изтриване само admin (immutable одит следа по подразбиране)
-- ------------------------------------------------------------

create policy attachments_select on attachments
  for select to authenticated
  using (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid())
  );

create policy attachments_insert on attachments
  for insert to authenticated
  with check (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid())
  );

create policy attachments_admin_delete on attachments
  for delete to authenticated
  using (is_admin());

-- ------------------------------------------------------------
-- task_payments — преглед/маркиране на плащане от отговорника
-- ------------------------------------------------------------

create policy task_payments_select on task_payments
  for select to authenticated
  using (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid())
  );

create policy task_payments_update on task_payments
  for update to authenticated
  using (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid())
  )
  with check (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid())
  );

create policy task_payments_admin_insert_delete on task_payments
  for insert to authenticated
  with check (is_admin());

create policy task_payments_admin_delete on task_payments
  for delete to authenticated
  using (is_admin());

-- ------------------------------------------------------------
-- audit_log / notification_log — само admin чете; запис само през
-- service_role (Edge Functions), затова няма insert политика за
-- authenticated — RLS без policy = забранено по подразбиране.
-- ------------------------------------------------------------

create policy audit_log_admin_select on audit_log
  for select to authenticated
  using (is_admin());

create policy notification_log_admin_select on notification_log
  for select to authenticated
  using (is_admin());

-- ------------------------------------------------------------
-- holidays — четими от всеки логнат потребител (нужни са и за
-- фронтенда, за да показва коректни срокове), редакция само admin.
-- cron_heartbeats — само admin ги вижда (диагностика).
-- ------------------------------------------------------------

create policy holidays_select on holidays
  for select to authenticated using (true);
create policy holidays_admin_write on holidays
  for all to authenticated using (is_admin()) with check (is_admin());

create policy cron_heartbeats_admin_select on cron_heartbeats
  for select to authenticated using (is_admin());

-- ------------------------------------------------------------
-- Справочни таблици (registration_types, activity_types,
-- obligation_types) — четими от всеки логнат потребител (не пазят
-- клиентски данни), редакция само admin.
-- ------------------------------------------------------------

alter table registration_types enable row level security;
alter table activity_types enable row level security;
alter table obligation_types enable row level security;

create policy registration_types_select on registration_types
  for select to authenticated using (true);
create policy registration_types_admin_write on registration_types
  for all to authenticated using (is_admin()) with check (is_admin());

create policy activity_types_select on activity_types
  for select to authenticated using (true);
create policy activity_types_admin_write on activity_types
  for all to authenticated using (is_admin()) with check (is_admin());

create policy obligation_types_select on obligation_types
  for select to authenticated using (true);
create policy obligation_types_admin_write on obligation_types
  for all to authenticated using (is_admin()) with check (is_admin());
