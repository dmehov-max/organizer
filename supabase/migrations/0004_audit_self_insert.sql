-- ============================================================
-- Органайзер — позволява на логнат потребител да пише в audit_log
-- САМО свои собствени действия (actor_user_id = auth.uid()).
-- Add-only остава вярно — няма update/delete политика за
-- authenticated, само admin select (0002) + тази insert политика.
-- ============================================================

create policy audit_log_self_insert on audit_log
  for insert to authenticated
  with check (actor_user_id = auth.uid());
