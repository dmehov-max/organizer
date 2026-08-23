# upload-document

Публичната точка, през която **клиентите** (не счетоводителите) качват
документи, без логин — виж коментарите в `index.ts` и миграция
`0059_incoming_documents.sql` за пълния контекст.

## Деплой

1. Приложи `supabase/migrations/0059_incoming_documents.sql` (SQL
   Editor, по същия начин като предишните — добавя `upload_token` на
   клиентите, таблица `incoming_documents`, bucket `incoming`).
2. Edge Functions → Create a new function → постави `index.ts` → Deploy.
3. **Изключи "Verify JWT"** (Settings таб на функцията) — клиентът
   няма Supabase сесия изобщо, точно както при `create-user`/
   `generate-tasks`.
4. Запиши реалното случайно име, което Supabase даде (виж
   `supabase/README.md` — там се пазят всички), и го сложи в
   `index.html` в константата `UPLOAD_DOCUMENT_URL`.
5. `upload.html` (в корена на репото) използва СЪЩАТА константа —
   провери, че и той сочи към правилния URL (търси
   `UPLOAD_DOCUMENT_URL` в началото на файла).

## Тест

В "Test" панела на функцията, Request Body (само проверка на линк,
нищо не пише):

```json
{ "token": "<upload_token на реален клиент от таблицата clients>" }
```

Очакван отговор: `{ "ok": true, "client_name": "..." }`. Реално
качване с файл се тества най-лесно през `upload.html` на живо, не
през Test панела (по-лесно е да прикачиш файл в браузъра).

## Проверка

```sql
select c.name, d.original_filename, d.status, d.received_at
from incoming_documents d join clients c on c.id = d.client_id
order by d.received_at desc limit 10;
```
