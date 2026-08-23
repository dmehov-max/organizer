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
6. `migrations/0005_fix_rls_recursion.sql` до `migrations/0033_*.sql`
   — поредица от инкрементални поправки/добавки (адрес на клиент,
   ДДС/СОЛ-с-личен-труд smart sync, преименувания и оттегляния на
   задължения по живи заявки и др.) — самите файлове са описателни,
   виж папката `migrations/` за пълния, актуален ред.

## Edge Functions (Edge Functions → Create a new function, paste, Deploy)

Supabase дава им случайно име, ако не смениш полето — записвай си
реалното кръстено име, кодът не го знае предварително:

- `functions/generate-tasks/` — дневен cron, генерира задачи (и вече
  и записи за плащане, ако задължението го изисква); извиква се и
  директно от index.html веднага след създаване на нов клиент (не се
  чака дневния крон). На живо като **`clever-responder`**.
- `functions/send-notifications/` — дневен cron, сборни имейли по
  служител + admin дайджест. Нужен secret `RESEND_API_KEY` (+
  опционално `RESEND_FROM`). На живо като **`hyper-service`**.
- `functions/recognize-confirmation/` — чете текста на прикачени PDF
  потвърждения (вх. номер, дублиране, ЕИК/име на фирма). На живо като
  **`hyper-handler`**.
- `functions/ai-helper/` — AI помощник, JWT-scoped контекст (не
  service_role). Нужен secret `ANTHROPIC_API_KEY`. На живо като
  **`super-handler`**.
- `functions/check-drive-files/` — проверява наличие на генерирани
  файлове в Firmi Google Drive папката по клиент/месец (SPEC.md §10;
  само наличие + дата на промяна, никога не чете съдържание). Нужни
  secrets `GOOGLE_SERVICE_ACCOUNT_KEY` (цялото JSON на service account
  ключа) и `FIRMI_FOLDER_ID`. Ползва РЪЧЕН RS256 JWT подпис през Deno
  Web Crypto — `npm:google-auth-library` чупеше Supabase bundler-а
  (виж git история). На живо като **`swift-worker`**.
- `functions/create-user/` — admin добавя нов потребител директно от
  приложението (Потребители таб → "+ Нов потребител"). Проверява
  РЕАЛНО дали викащият е admin (JWT-scoped клиент, не се доверява на
  тялото на заявката), после ползва service_role да създаде Auth
  акаунт + профилен ред. Връща временна парола в отговора (не праща
  покана-имейл — виж коментара в кода защо `inviteUserByEmail` е
  умишлено избегнат). На живо като **`hyper-function`**.
- `functions/upload-document/` — публична точка (без Auth), през
  която КЛИЕНТИТЕ качват документи през `upload.html?t=<upload_token>`.
  Проверява токена срещу `clients.upload_token`, пише със
  service_role в bucket `incoming` + таблица `incoming_documents`.
  Изисква миграция `0059_incoming_documents.sql`. Виж README-то в
  папката на функцията за деплой стъпки — **след деплой запиши
  реалното случайно име и в `UPLOAD_DOCUMENT_URL` (index.html) И в
  `upload.html`**, двата файла го пазят отделно.

Виж `SPEC.md` в основната папка за пълния модел и обосновка, и
`.env` (локално, gitignored) за текущите ключове.

## Тестове

Всичките седем функции имат `index.test.ts` до себе си — тестват
чистите функции (дата смятане,
разпознаване на потвърждения, извличане на текстов отговор от Claude,
съпоставяне на Drive папки), без да пипат живата база. Написани са
след като живо тестване разкри реални бъгове (RLS рекурсия, счупен
regex за отхвърлени декларации, "(няма отговор)" при thinking блок и
др. — виж git история) — целта е да не се повтарят.

```
deno test --allow-net --allow-env supabase/functions/
```

`Deno.serve(...)` е защитено с `if (import.meta.main)` във всяка
функция — затова тестовият импорт не стартира истински сървър.
