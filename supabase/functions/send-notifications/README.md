# send-notifications — дневен cron за известия

Виж коментарите в `index.ts` и `SPEC.md` §5.

## Преди деплой — нужен е Resend акаунт

1. Регистрация на [resend.com](https://resend.com) (безплатен план е
   достатъчен за начало — 100 имейла/ден, 3000/месец).
2. **API Keys** → Create API Key → копирай ключа (започва с `re_...`).
3. **Domains** → добави домейн (напр. поддомейн на `korekt-bg.com`) и
   верифицирай през DNS записите, които Resend дава — иначе можеш да
   пращаш само до собствения си имейл (sandbox режим), не към екипа.
   Може да продължим първо в sandbox за тест, домейн — по-late.

## Деплой (през таблото, без CLI)

1. Supabase таблото → **Edge Functions** → Create a new function →
   постави съдържанието на `index.ts` → Deploy
2. **Edge Functions → Secrets** → добави:
   - `RESEND_API_KEY` = ключът от Resend
   - `RESEND_FROM` = напр. `Органайзер <organizer@korekt-bg.com>`
     (или остави без него, ще ползва временен sandbox адрес)
3. Насрочи да се пуска дневно — таб Cron/Schedule на функцията,
   разписание напр. `0 5 * * *` (след `generate-tasks`, за да са
   задачите вече създадени за деня).

## Проверка

```sql
select * from cron_heartbeats where job_name = 'daily_notifications' order by ran_at desc limit 5;
select * from notification_log order by sent_at desc limit 20;
```
