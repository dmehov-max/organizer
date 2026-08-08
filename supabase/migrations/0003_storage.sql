-- ============================================================
-- Органайзер — Storage bucket за прикачени файлове (SPEC.md §11)
--
-- Частен bucket, достъп само през подписани URL-и / RLS, не публичен.
-- Конвенция за път: <task_id>/<произволно име на файла> — политиките
-- по-долу извличат task_id от първата "папка" в пътя (storage.foldername)
-- и проверяват достъпа през същите правила като таблицата `tasks`.
-- ============================================================

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

-- Помощна: task_id от пътя на файла
create or replace function attachment_task_id(object_name text)
returns uuid
language sql
stable
as $$
  select (storage.foldername(object_name))[1]::uuid;
$$;

create policy attachments_storage_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'attachments'
    and (
      is_admin()
      or exists (
        select 1 from tasks t
        where t.id = attachment_task_id(name) and t.assigned_user_id = auth.uid()
      )
    )
  );

create policy attachments_storage_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (
      is_admin()
      or exists (
        select 1 from tasks t
        where t.id = attachment_task_id(name) and t.assigned_user_id = auth.uid()
      )
    )
  );

create policy attachments_storage_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'attachments' and is_admin());
