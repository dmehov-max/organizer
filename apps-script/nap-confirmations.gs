// Органайзер — потвържденията от НАП → „Подаване“ в Органайзера.
// Google Apps Script в пощата d.mehov@korekt-bg.com (поискано
// изрично 2026-10-29). Инсталиране: виж
// supabase/functions/nap-confirmation-email/README.md.
//
// Какво прави: на всеки 15 минути взима новите „Потвърждение“ от
// eServices@nra.bg и ги праща на edge функцията nap-confirmation-email.
// Тя решава коя задача е и какво да впише — тук няма логика.
//
// Script Properties (Project Settings → Script properties):
//   WEBHOOK_URL    — https://ekyvbmokklfyrjkshuuu.supabase.co/functions/v1/nap-confirmation-email
//   WEBHOOK_SECRET — създава се с generateSecret(); същата стойност е
//                    NAP_MAIL_WEBHOOK_SECRET в Supabase

var QUERY = 'from:eservices@nra.bg subject:Потвърждение';
var BATCH = 20;
var MAX_SENT_IDS = 300; // помни изпратените, за да не ги праща пак

/** Основната функция — нея пуска тригерът. */
function checkNapConfirmations() {
  run_('newer_than:3d', false, true);
}

/** Пробно за последните 120 дни: НИЩО не се записва в Органайзера,
 * само показва в лога (View → Executions) какво би се вписало. */
function backfillDryRun() {
  run_('newer_than:120d', true, false);
}

/** Истинско вписване за последните 120 дни — само след като
 * backfillDryRun() изглежда наред. Вече вписаното на ръка не се пипа. */
function backfill() {
  run_('newer_than:120d', false, true);
}

/** Пуска checkNapConfirmations на всеки 15 минути. Веднъж. */
function install() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkNapConfirmations') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkNapConfirmations').timeBased().everyMinutes(15).create();
}

/** Създава тайната и я записва в Script Properties. Стойността се
 * показва ВЕДНЪЖ в лога — копирай я в Supabase като
 * NAP_MAIL_WEBHOOK_SECRET и не я пиши никъде другаде. */
function generateSecret() {
  var s = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('WEBHOOK_SECRET', s);
  Logger.log('NAP_MAIL_WEBHOOK_SECRET = ' + s);
}

function run_(age, dryRun, rememberSent) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return; // предишното пускане още върви
  try {
    var props = PropertiesService.getScriptProperties();
    var url = props.getProperty('WEBHOOK_URL');
    var secret = props.getProperty('WEBHOOK_SECRET');
    if (!url || !secret) throw new Error('Липсва WEBHOOK_URL или WEBHOOK_SECRET в Script Properties');

    var sent = JSON.parse(props.getProperty('SENT_IDS') || '[]');
    var sentSet = {};
    sent.forEach(function (id) { sentSet[id] = true; });

    var messages = [];
    GmailApp.search(QUERY + ' ' + age, 0, 200).forEach(function (thread) {
      thread.getMessages().forEach(function (m) {
        if (!/eservices@nra\.bg/i.test(m.getFrom())) return;
        if (!/Потвърждение/.test(m.getSubject())) return;
        if (rememberSent && sentSet[m.getId()]) return;
        messages.push(m);
      });
    });
    // Най-старите първо — псевдонимите на фирмите се учат от по-старите писма.
    messages.sort(function (a, b) { return a.getDate() - b.getDate(); });

    var total = { processed: 0, updated: 0, already: 0, needs_review: 0 };
    for (var i = 0; i < messages.length; i += BATCH) {
      var chunk = messages.slice(i, i + BATCH);
      var res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-webhook-secret': secret },
        muteHttpExceptions: true,
        payload: JSON.stringify({
          dry_run: dryRun,
          messages: chunk.map(function (m) {
            return {
              id: m.getId(),
              date: m.getDate().toISOString(),
              subject: m.getSubject(),
              text: m.getPlainBody(),
              html: m.getBody(),
            };
          }),
        }),
      });
      if (res.getResponseCode() !== 200) {
        throw new Error('Органайзер ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 500));
      }
      var body = JSON.parse(res.getContentText());
      ['processed', 'updated', 'already', 'needs_review'].forEach(function (k) { total[k] += body[k] || 0; });
      (body.results || []).forEach(function (r) {
        if (dryRun || (r.result !== 'already')) {
          Logger.log([r.result, r.reference_number, r.applicant_name, r.period_label, (r.obligation_codes || []).join('+'), r.matched_by || '', r.details || ''].join(' | '));
        }
      });
      if (rememberSent) {
        chunk.forEach(function (m) { sent.push(m.getId()); });
        props.setProperty('SENT_IDS', JSON.stringify(sent.slice(-MAX_SENT_IDS)));
      }
    }
    Logger.log((dryRun ? '[ПРОБНО] ' : '') + JSON.stringify(total));
  } finally {
    lock.releaseLock();
  }
}
