-- ============================================================
-- История на вход — "кога последно са влизали" потребителите,
-- поискано изрично 2026-08-20. Самостоятелна таблица (не четем
-- auth.users.last_sign_in_at — не е достъпно през обикновен PostgREST
-- заявка, а само през Admin API/service_role, което би значело нова
-- Edge Function само за това). Всеки ред = един успешен вход с
-- имейл+парола (записва се от index.html веднага след успешен
-- signInWithPassword, преди MFA стъпката — "влязъл" на ниво парола).
-- ============================================================

create table login_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  logged_in_at timestamptz not null default now()
);

create index idx_login_log_user on login_log(user_id, logged_in_at desc);

alter table login_log enable row level security;

create policy login_log_select on login_log
  for select to authenticated
  using (is_admin() or user_id = auth.uid());

create policy login_log_insert on login_log
  for insert to authenticated
  with check (user_id = auth.uid());
