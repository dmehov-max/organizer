-- ============================================================
-- Органайзер — admin спира достъпа на служител (без изтриване на
-- акаунта/данните му, обратимо).
--
-- Досега `profiles.active` съществуваше в схемата, но реално пазеше
-- само дали НЯКОЙ е admin (is_admin() го проверява). За счетоводител
-- нищо в RLS не гледаше active — деактивиран счетоводител си
-- запазваше пълен достъп до собствените клиенти/задачи, защото
-- политиките сравняват assigned_user_id/responsible_user_id direкtно
-- с auth.uid(), не минават през функция. Тази миграция затваря тази
-- дупка: нова is_active() проверка, добавена към всяко място, което
-- досега разчиташе само на auth.uid() сравнение.
--
-- Забележка: паролата остава недостъпна за преглед и след тази
-- миграция (Supabase Auth пази само хеш) — това спира ЧЕТЕНЕ/ПИСАНЕ
-- на данни през приложението, не е "забрана за вход" на ниво Auth.
-- Вече издаден JWT токен продължава да работи технически до logout/
-- изтичане, но всяка заявка към данни минава RLS и връща празно —
-- деактивираният вижда само собствения си (непроменен) профилен ред.
-- За 3-4 потребителя това е достатъчно; ако потрябва твърдо прекъсване
-- на самата сесия, се добавя Edge Function със service_role, която
-- вика supabase.auth.admin.signOut(userId) — не е направено тук.
-- ============================================================

create or replace function is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select active from profiles where id = auth.uid()), false);
$$;

-- is_client_owner() пази целия "фамилия от клиента" клон
-- (client_registrations/client_activities/client_dossier_flags/
-- client_dossier_info/client_obligation_settings) — една поправка тук
-- стига за всички тях.
create or replace function is_client_owner(target_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from clients
    where id = target_client_id and responsible_user_id = auth.uid()
  ) and is_active();
$$;

-- clients — прякото сравнение с auth.uid() не минава през
-- is_client_owner(), затова се поправя отделно.
drop policy if exists clients_select on clients;
create policy clients_select on clients
  for select to authenticated
  using (is_admin() or (responsible_user_id = auth.uid() and is_active()));

-- tasks
drop policy if exists tasks_select on tasks;
create policy tasks_select on tasks
  for select to authenticated
  using (is_admin() or (assigned_user_id = auth.uid() and is_active()));

drop policy if exists tasks_update on tasks;
create policy tasks_update on tasks
  for update to authenticated
  using (is_admin() or (assigned_user_id = auth.uid() and is_active()))
  with check (is_admin() or (assigned_user_id = auth.uid() and is_active()));
  -- tasks_insert вече минава през is_client_owner() (виж 0002) — покрит
  -- индиректно, не се пипа тук.

-- task_sick_leave_details
drop policy if exists task_sick_leave_select on task_sick_leave_details;
create policy task_sick_leave_select on task_sick_leave_details
  for select to authenticated
  using (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid() and is_active())
  );

drop policy if exists task_sick_leave_write on task_sick_leave_details;
create policy task_sick_leave_write on task_sick_leave_details
  for all to authenticated
  using (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid() and is_active())
  )
  with check (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid() and is_active())
  );

-- attachments
drop policy if exists attachments_select on attachments;
create policy attachments_select on attachments
  for select to authenticated
  using (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid() and is_active())
  );

drop policy if exists attachments_insert on attachments;
create policy attachments_insert on attachments
  for insert to authenticated
  with check (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid() and is_active())
  );

-- task_payments
drop policy if exists task_payments_select on task_payments;
create policy task_payments_select on task_payments
  for select to authenticated
  using (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid() and is_active())
  );

drop policy if exists task_payments_update on task_payments;
create policy task_payments_update on task_payments
  for update to authenticated
  using (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid() and is_active())
  )
  with check (
    is_admin()
    or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid() and is_active())
  );
