-- ============================================================
-- Органайзер — поправка на безкрайна рекурсия в RLS.
--
-- Бъг: is_admin()/is_client_owner() четат от `profiles`/`clients`,
-- без SECURITY DEFINER — значи вътрешната им заявка ПАК минава през
-- RLS политиките на същите таблици, които ги викат → безкрайна
-- рекурсия → "stack depth limit exceeded" (видяно на живо при първи
-- реален тест на frontend-а).
--
-- Поправка: SECURITY DEFINER кара функцията да изпълнява вътрешната
-- си заявка с правата на собственика (обикновено бai-pass-ва RLS за
-- table owner-а), не на викащия потребител — прекъсва цикъла.
-- set search_path е задължителна добавка за security definer
-- функции (пази от search_path hijacking).
-- ============================================================

create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
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
security definer
set search_path = public
as $$
  select exists (
    select 1 from clients
    where id = target_client_id and responsible_user_id = auth.uid()
  );
$$;
