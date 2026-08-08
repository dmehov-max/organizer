# ai-helper

Първа, опростена версия — виж бележките в `index.ts`. Отговаря на
общи въпроси за работа със системата, няма достъп до реални клиентски
данни още (следваща стъпка, с JWT passthrough, не service_role —
SPEC.md §12).

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
