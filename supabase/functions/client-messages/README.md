# client-messages

Публична точка (без Auth) за чата с клиента — виж коментарите в
`index.ts` и миграция `0061_client_messages.sql`. Огледален модел на
`upload-document`: `upload_token` на клиента е единствената "автентикация".

## Деплой

1. Приложи `supabase/migrations/0061_client_messages.sql` (SQL Editor).
2. Edge Functions → Create a new function → име `client-messages` →
   постави `index.ts` → Deploy.
3. **Изключи "Verify JWT"** (Settings таб) — клиентът няма сесия.
4. Запиши реалното деплойнато име (виж бележката в `upload-document/README.md`
   за прецедента с необичайно тройно тире) и го сложи в `upload.html`,
   константа `CLIENT_MESSAGES_URL` — index.html НЕ ползва тази функция,
   пише директно през supabase-js (authenticated сесия).

## Тест

Request Body (само зареждане на нишката, нищо не пише):

```json
{ "token": "<upload_token на реален клиент>" }
```

С изпращане на съобщение:

```json
{ "token": "<...>", "body": "Здравейте, кога да очаквам фактурата?" }
```

## Проверка

```sql
select c.name, m.sender, m.body, m.created_at
from client_messages m join clients c on c.id = m.client_id
order by m.created_at desc limit 10;
```
