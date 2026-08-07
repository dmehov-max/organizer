# Supabase — схема

- `migrations/0001_init.sql` — начална схема: клиенти, регистрации,
  дейности, досие, видове задължения, настройки на клиент, задачи,
  прикачени файлове, плащания, одит лог, лог на известия. RLS е
  включено навсякъде, но без политики (fail-closed) — политиките идват
  в отделна миграция (Прогрес #9 — Сигурност).
- `seed.sql` — попълва `registration_types`, `activity_types` и
  `obligation_types` с целия каталог от `SPEC.md` §6.

Виж `SPEC.md` в основната папка за пълния модел и обосновка.

## Все още няма създаден Supabase проект

Схемата е готова, но не е приложена никъде — нямаме още провизиран
Supabase проект. Стъпки, когато решиш:

1. Създаваш проект на [supabase.com](https://supabase.com) (безплатен
   tier е достатъчен за начало).
2. `supabase link --project-ref <ref>` (или през SQL editor в
   таблото — copy/paste на файловете, ако не искаш CLI).
3. `supabase db push` (прилага `migrations/`), после ръчно изпълняваш
   `seed.sql` веднъж.
4. Пазим `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
   в `.env` (никога в git) — виж `SPEC.md` §11.
