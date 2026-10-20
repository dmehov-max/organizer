-- ============================================================
-- Органайзер — cron за проверката на Drive (check-drive-files, на
-- живо като "swift-worker"), добавено 2026-10-20 заедно с
-- автоматичното отбелязване на Декл. обр. 1 и 6
-- (functions/check-drive-files/DECLARATIONS.md).
--
-- Открито при настройката: съществуващата cron задача с име
-- "daily_drive_check" всъщност вика clever-responder, т.е.
-- generate-tasks, а НЕ проверката на Drive. Името е подвеждащо, но
-- задачата върши нужна работа (дневното генериране на задачи) и
-- остава непипната. Проверката на Drive досега НЕ е тръгвала
-- автоматично (последен heartbeat "drive_file_check": 10.08.2026,
-- ръчно).
--
-- Новата задача се пуска на всеки 2 часа в работно време
-- (06:15–18:15 UTC = 09:15–21:15 лятно / 08:15–20:15 зимно време),
-- за да се отметне "Създаване" скоро след като декларацията се
-- появи в Firmi.
--
-- Bearer токенът се взима от съществуващата задача, за да не попада
-- ключ в git. ВНИМАНИЕ: там хедърът е записан като " Authorization"
-- (с интервал отпред). За clever-responder (verify_jwt изключен) това
-- не пречи, но swift-worker е с verify_jwt и такъв хедър би дал 401 —
-- затова командата се сглобява наново с правилно име на хедъра.
--
-- Идемпотентна: cron.schedule с вече съществуващо име обновява
-- задачата, не създава втора.
-- ============================================================

do $$
declare
  v_token text;
  v_url text;
begin
  select substring(command from 'Bearer ([A-Za-z0-9._-]+)'),
         substring(command from 'url:=''(https://[^/]+)/functions/v1/')
    into v_token, v_url
  from cron.job
  where jobname = 'daily_drive_check';

  if v_token is null or v_url is null then
    raise exception 'Не намерих токен/URL в daily_drive_check — провери cron.job ръчно';
  end if;

  perform cron.schedule(
    'drive_file_check_2h',
    '15 6-18/2 * * *',
    format(
      $cmd$select net.http_post(url := %L, headers := %L::jsonb, body := '{}'::jsonb, timeout_milliseconds := 150000);$cmd$,
      v_url || '/functions/v1/swift-worker',
      jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json')::text
    )
  );
end $$;
