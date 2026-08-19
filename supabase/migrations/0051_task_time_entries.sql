-- ============================================================
-- Разширява работния таймер (0049) и към задачите — поискано изрично
-- 2026-08-19 ("При задачите също трябва да се отчита време"). Отделна
-- таблица, не разширение на time_entries — различен модел на
-- собственост (през tasks.assigned_user_id, не clients.responsible_user_id)
-- и различни "клетки" (task_id × етап, не client × година × категория
-- × месец).
-- ============================================================

create table task_time_entries (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  stage text not null check (stage in ('creation', 'review', 'submission')),
  user_id uuid not null references profiles(id),
  started_at timestamptz not null default now(),
  stopped_at timestamptz,
  auto_stopped boolean not null default false
);

create index idx_task_time_entries_task on task_time_entries(task_id, stage);
create index idx_task_time_entries_open on task_time_entries(user_id) where stopped_at is null;

alter table task_time_entries enable row level security;

create policy task_time_entries_select on task_time_entries
  for select to authenticated
  using (is_admin() or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid()));

create policy task_time_entries_insert on task_time_entries
  for insert to authenticated
  with check (
    (is_admin() or exists (select 1 from tasks t where t.id = task_id and t.assigned_user_id = auth.uid()))
    and user_id = auth.uid()
  );

create policy task_time_entries_update on task_time_entries
  for update to authenticated
  using (is_admin() or user_id = auth.uid())
  with check (is_admin() or user_id = auth.uid());
