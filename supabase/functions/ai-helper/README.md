# ai-helper

v2 — виж бележките в `index.ts`. Отговаря на общи въпроси за работа
със системата, и ако получи Authorization header (JWT-то на
питащия — frontend-ът вече го праща), добавя кратък обобщен контекст
(брой отворени/просрочени задачи) през клиент, скопиран с ТОВА JWT —
не service_role, RLS важи изцяло (SPEC.md §12).

## Деплой

1. Нужен е Anthropic API ключ: [console.anthropic.com](https://console.anthropic.com)
   → API Keys → Create Key.
2. Edge Functions → Secrets → добави `ANTHROPIC_API_KEY`.
3. Edge Functions → Create a new function → постави `index.ts` → Deploy.
4. Изключи "Verify JWT" (Settings таб), както при другите — този
   proxy сам проверява само, че има съобщение, не автентикация към
   Supabase (той не пипа Supabase изобщо в тази версия).

## Тест

В "Test" панела на функцията, Request Body:
```json
{ "message": "Как да маркирам задача като завършена?" }
```
Очакван отговор — кратко обяснение на български.
