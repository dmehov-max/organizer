# Supabase — схема и функции

Проектът "organizer" вече е жив (EU регион, project ref
`ekyvbmokklfyrjkshuuu`) — това по-долу е за справка/повторение, ако
някога трябва да се пресъздаде от нулата.

## Ред за прилагане (SQL Editor, по един файл)

1. `migrations/0001_init.sql` — начална схема: клиенти, регистрации,
   дейности, досие (вече с история по период), видове задължения
   (версионирани), настройки на клиент, задачи (разширен жизнен цикъл
   — корекции, удължаване, "не се дължи"), прикачени файлове, плащания,
   празници, одит лог, лог на известия, heartbeat. RLS включено
   навсякъде (fail-closed).
2. `migrations/0002_rls_policies.sql` — политиките (admin вижда/пипа
   всичко, счетоводител — само своите клиенти/задачи).
3. `seed.sql` — попълва `registration_types`, `activity_types`,
   `obligation_types` (целия каталог от `SPEC.md` §6) + стартов
   празничен календар за 2026 (**провери срещу решение на МС**).
4. `migrations/0003_storage.sql` — частен bucket `attachments` + RLS.
5. `migrations/0004_audit_self_insert.sql` — позволява на всеки
   потребител да пише в `audit_log` само свои действия.

## Edge Functions (Edge Functions → Create a new function, paste, Deploy)

Supabase дава им случайно име, ако не смениш полето — записвай си
реалното кръстено име, кодът не го знае предварително:

- `functions/generate-tasks/` — дневен cron, генерира задачи (и вече
  и записи за плащане, ако задължението го изисква). На живо като
  **`clever-responder`**.
- `functions/send-notifications/` — дневен cron, сборни имейли по
  служител + admin дайджест. Нужен secret `RESEND_API_KEY` (+
  опционално `RESEND_FROM`). На живо като **`hyper-service`**.
- `functions/recognize-confirmation/` — чете текста на прикачени PDF
  потвърждения. ⚠️ Използва библиотека (`unpdf`), непотвърдена на
  живо — виж README в папката ѝ. Все още недеплойната.
- `functions/ai-helper/` — AI помощник, JWT-scoped контекст (не
  service_role). Нужен secret `ANTHROPIC_API_KEY`. Все още
  недеплойната.

Виж `SPEC.md` в основната папка за пълния модел и обосновка, и
`.env` (локално, gitignored) за текущите ключове.
