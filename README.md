# Органайзер

Система за проследяване на нормативни срокове за фирмите, обслужвани
счетоводно от **Мехов Консулт** ЕООД. Многопотребителска, с автоматични
напомняния/ескалации по имейл — цел: нито един пропуснат срок.

Пълната спецификация е в [SPEC.md](./SPEC.md).

## Статус

Спецификация ✓, Supabase схема+RLS+seed ✓ (проект `organizer`, EU),
Auth (3 акаунта) ✓, cron генериране на задачи ✓ (Edge Function, на
живо като `clever-responder`), известия ✓ (Edge Function, на живо
като `hyper-service`). Frontend MVP — `index.html` (табло със задачи +
списък клиенти за admin), готов за преглед, все още недеплойнат.

Предстои: разпознаване на PDF потвърждения, деплой в GitHub Pages,
MFA/private storage, Drive интеграция, AI помощник.

### Как да пробваш `index.html`

**Не го отваряй директно (двоен клик)** — Supabase заявките may fail
заради `file://` произход (CORS). Или го качи на GitHub Pages (виж
Прогрес #8), или пусни локален статичен сървър в тази папка, напр.
`npx serve` (изисква Node.js), и отвори адреса, който покаже.

## Стек

- Frontend: статичен сайт → GitHub Pages (custom domain)
- Backend: Supabase (Postgres, Auth, Storage, Edge Functions)
- Имейли: Resend (през Edge Function)
