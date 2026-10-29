# nap-confirmation-email

Вписва „Подаване“ и входящия номер от имейлите на НАП
(„Потвърждение за получаване“ от `eServices@nra.bg`). Писмата се
взимат от Google Apps Script в пощата на Дойчин
(`apps-script/nap-confirmations.gs`) и се пращат тук. Миграция:
`0074_nap_confirmation_emails.sql`.

## Какво се засича

| Писмо | Фирма | Задачи |
|---|---|---|
| Декларация образец № 1 и/или № 6 „за период ММ/ГГГГ“ | **само име** (без ЕИК) | `obr1`, `obr6_monthly` |
| Месечна справка-декларация по ЗДДС „за период: ГГГГММ“ | ЕИК от `VIN BG…` | `vat_declaration` |
| Всичко друго (чл. 55, ГДД…) | — | нищо, само ред в дневника (`unknown_document`) |

Фирмата: ЕИК → псевдоним (`client_nap_names`) → точно име без правната
форма. Никога „съдържа“ — „ДЖИ ДИ ЕМ ГРУП“ ≠ „ДЖИ ДИ ЕМ ГРУП 2019“.
Псевдонимите се учат сами: ако входящият номер вече е вписан на ръка
в задача, името от писмото се закача за нейния клиент.

В задачата: `stage_submission_done`, `stage_submission_done_at` (часът
на писмото) и `submission_reference_number` (`30E015846227/21.10.2026`)
— само ако ги няма. Друг вписан номер → `conflict`, нищо не се
презаписва. Статусът и „Прието“ НЕ се пипат.

Всяко писмо оставя ред в `nap_confirmation_emails` с `result`:
`updated`, `already`, `no_task`, `no_client`, `unknown_document`,
`conflict`, `unparsed`. За преглед на пропуснатите:

```sql
select received_at, result, applicant_name, period_label, obligation_codes, details
from nap_confirmation_emails
where result not in ('updated', 'already', 'unknown_document')
order by received_at desc;
```

## Деплой

1. Приложи `0074_nap_confirmation_emails.sql`.
2. Деплойни функцията с име `nap-confirmation-email`, **Verify JWT
   изключен** (Apps Script няма Supabase сесия; пази я тайната в
   хедъра `x-webhook-secret`).
3. Apps Script (script.google.com, влязъл като d.mehov@korekt-bg.com):
   1. Нов проект „Органайзер — НАП потвърждения“, постави
      `apps-script/nap-confirmations.gs`.
   2. Project Settings → Script properties → `WEBHOOK_URL` =
      `https://ekyvbmokklfyrjkshuuu.supabase.co/functions/v1/nap-confirmation-email`.
   3. Пусни `generateSecret` (при първото пускане Google пита за
      достъп до Gmail и външни заявки — разреши). Копирай стойността
      от лога в Supabase → Edge Functions → Secrets като
      `NAP_MAIL_WEBHOOK_SECRET`.
   4. Пусни `backfillDryRun` и прегледай лога — нищо не се записва.
   5. Ако е наред: `backfill` (вписва и учи псевдонимите от историята),
      после `install` (тригер на 15 минути).
