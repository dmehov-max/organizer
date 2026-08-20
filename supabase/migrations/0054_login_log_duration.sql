-- Продължителност на сесия — поискано изрично 2026-08-20, продължение
-- на 0053. logged_out_at се пише при изричен изход ИЛИ при
-- авто-изход поради неактивност; ако липсва (браузърът е затворен
-- рязко, без изход), продължителността остава неизвестна — не е
-- решено тук (виж коментара в index.html).
alter table login_log add column logged_out_at timestamptz;

create policy login_log_update on login_log
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
