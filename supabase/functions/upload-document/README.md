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

## Втори режим — "засечено по имейл" (0060)

Освен качване от клиента, функцията приема и `{ token, filename,
source_url, note? }` (без `file_base64`) — логва находка в
`incoming_documents` БЕЗ да мести файла, само с линк към Gmail
писмото (`source_url`). Използва се за ръчна "проверка на пощата":
Дойчин моли Клод (в чат сесия) да провери кои клиентски имейли
(`clients.contact_emails`, 0060) имат непреглеждани писма с
прикачени файлове, и за намерените — вика тази функция веднъж на
находка. Изисква Клод да прочете `upload_token` на клиента (read-only
SELECT през локалния `.env` service_role ключ — позволено, само
mutating заявки през Bash са блокирани).

Все още **не е автоматично** — трябва изрично да се поиска на сесия.
Истинска фонова автоматизация би значела или (а) насрочена cloud
задача, която пази същия Gmail connector достъп между извикванията
(непотвърдено дали работи така), или (б) истински Gmail API service
account с domain-wide delegation (като `check-drive-files` за Drive)
— по-стабилно, но изисква Google Workspace admin достъп за настройка.
Обсъди с Клод кое е приоритет, ако ръчната проверка стане тромава.

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
