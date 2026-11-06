-- ============================================================
-- Органайзер — папка на всяка фирма в Google Drive (Firmi/<фирма>),
-- добавено 2026-10-28.
--
-- Досега проверката на Drive (check-drive-files, на живо като
-- "swift-worker") търсеше папката на фирмата по ПРИЛИКА на името
-- (folderNameMatchesClient). Това грешеше в двете посоки:
--   - хващаше грешна папка: "ДЖИ ДИ ЕМ ГРУП" ↔ "ДЖИ ДИ ЕМ ГРУП 2019";
--   - пропускаше вярната: "Корект Преместване ЕООД" ↔
--     "КОРЕКТ ПРЕМЕСТВАНЕ  ООД", "Петанои" ↔ "ПЕНТАНОИ ЕООД".
-- Затова пазим ID-то на папката директно в clients.drive_folder_id;
-- засичането по име остава само резервен вариант, когато е празно.
--
-- drive_folder_url се изчислява от ID-то (generated column) — за
-- бутона „Папка в Drive“ в картата на фирмата.
--
-- Данните са засечени по ЕИК на 28.10.2026: всяка от 35-те фирми има
-- точно една папка директно под Firmi. Приложена на живо на
-- 2026-10-28 (Supabase migration "0073_clients_drive_folder").
--
-- Идемпотентна: "add column if not exists", а update-ът просто
-- презаписва същите стойности.
-- ============================================================

alter table public.clients
  add column if not exists drive_folder_id text
    check (drive_folder_id is null or drive_folder_id ~ '^[A-Za-z0-9_-]{10,100}$'),
  add column if not exists drive_folder_url text
    generated always as (case when drive_folder_id is null then null
                              else 'https://drive.google.com/drive/folders/' || drive_folder_id end) stored;

comment on column public.clients.drive_folder_id is
  'ID на папката на фирмата в Google Drive (Firmi/<фирма>). Ползва се от Drive проверките вместо засичане по име.';
comment on column public.clients.drive_folder_url is
  'Линк към папката на фирмата в Google Drive — изчислява се от drive_folder_id.';

-- Данни: засичането по ЕИК → ID на папка е приложено на живо на
-- 28.10.2026. Самият списък (ЕИК, ID на папка, име на фирма) НЕ стои
-- в публичното репо — пази се локално, извън git, в
-- supabase/private/0073_backfill_drive_folders.sql (виж
-- supabase/private/README.md). При пресъздаване на базата се пуска
-- след тази миграция; за нов клиент ID-то се попълва от досието.
