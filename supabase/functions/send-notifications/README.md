# send-notifications — имейл известия до служителите

На живо като **`hyper-service`**. Дневен сборен имейл на служител за
наближаващи срокове (5 раб. дни / утре / днес), тревога при отказано
потвърждение, непрочетени вътрешни съобщения и дайджест на
просроченото до admin-ите. Идемпотентно през `notification_log`.

## Изпращане (от 07.11.2026)

Всички писма от системата тръгват от **info@mehovconsult.com** през
SMTP на пощенския сървър на домейна (порт 465), с пауза между
писмата. Resend вече не се ползва (домейнът там не беше верифициран и
писмата падаха с 403).

Secrets (Edge Functions → Secrets), същите като при
`vat-documents-reminder` и `forward-to-controlisy`:

- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`

## Cron

Към 07.11.2026 **няма** cron задача за тази функция (последен пуск
08.08.2026). Включва се по образец на `migrations/0072_drive_check_cron.sql`
(дневно в 06:00 UTC, URL `/functions/v1/hyper-service`).

## Тестове

```
deno test --allow-net --allow-env supabase/functions/send-notifications/
```
