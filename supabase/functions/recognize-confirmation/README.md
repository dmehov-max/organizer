# recognize-confirmation

⚠️ **Тази функция използва библиотека (`unpdf`), която не е тествана
на живо в Supabase Edge Functions среда** — писана е добросъвестно по
документацията ѝ, но PDF/Deno edge съвместимостта трябва да се
провери с реален деплой и реален файл, преди да разчитаме на нея.
Ако при първия тест хвърля грешка при импорт/извличане, вероятно
трябва алтернативна библиотека (fallback: `pdf-parse` или извикване
на външен PDF-to-text API) — кажи ми грешката и ще коригирам.

## Деплой

1. Приложи `supabase/migrations/0003_storage.sql` (SQL Editor, по
   същия начин като предишните — създава частния `attachments`
   bucket + RLS политики).
2. Edge Functions → Create a new function → постави `index.ts` → Deploy.
3. **Database Webhook** (за автоматично тригериране при качване):
   Supabase таблото → **Database → Webhooks** → Create a new webhook:
   - Table: `attachments`
   - Events: `INSERT`
   - Type: HTTP Request → URL на тази функция
   - Header: `Authorization: Bearer <service_role key>` (или anon —
     без "Verify JWT" изключен на функцията, виж предната настройка,
     каквато направихме на `generate-tasks`/`send-notifications`)

## Проверка

Качи тестов PDF в bucket-а за задача с прикачено потвърждение (през
frontend-а, когато го добавим — засега може ръчно през Storage таблото
+ ръчен ред в `attachments`), после:

```sql
select recognized_marker, recognized_text_excerpt from attachments order by uploaded_at desc limit 1;
select confirmation_status from tasks where id = '<task_id>';
```
