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

-- Данни: засичане по ЕИК (папките са в Firmi, проверени на 28.10.2026)
update public.clients c set drive_folder_id = v.folder_id
from (values
  ('207635367', '18FlTmhBCma88vY4fqG1E2t9Yd4fhawTE'), -- АГППМПДМ- ЛМ - ДЕНТ  ООД
  ('207785185', '1iy6a5AtypcCB2JaIKVfLfqoHNlvYh3bD'), -- АИПДП- МИЛЕНИУМ ДЕНТАЛ КЕЪР ЕООД
  ('206636480', '1-749ODLaVIypn6T2ch0IhUOwSbbKxaup'), -- АИППМПДМ ДЕНТАЛ ПОЙНТ ЕООД
  ('208117370', '1XWm_es5VH-XaFs-58h7fe65ZLMjzq0YK'), -- БЛУ ХОРАЙЗЪН
  ('206430270', '1jLaO7RVd_RyHxdTpF2pGRkOo-yAqHWWG'), -- БОРИСА ЕКСПРЕС ЕООД
  ('204229571', '1qVcp_Wk6n0Dqt_m-1k5meoc63GAggv4E'), -- БУЛГАРО 9 ЕООД
  ('204470152', '1eN6TevXrooQ2igut8kmS1NL6NLN8FD2p'), -- БУТИК 15А 2017
  ('208919018', '1fpNpSrJYZO_hHpyNwvNQ6tC13hd2QT5l'), -- ВАМИБЕКС ЕООД
  ('206521026', '1FFfhDBL0LwUHT3FIGzby6__hGmuNvTcO'), -- ВИЖУАЛАЙЗ ООД
  ('204186426', '1t9SXy1jDOj2vlv1cPzocaIDN-IhwCwRb'), -- ДЖИ ДИ ЕМ БГ 2016
  ('202713730', '1KTJpY5r9oYcGY0GSFEQpeIjTraq7dBWE'), -- ДЖИ ДИ ЕМ ГРУП
  ('205482691', '1eHcnot9uD3p6IBnXgO1NfWypT3FrVvXv'), -- ДЖИ ДИ ЕМ ГРУП 2019
  ('206570906', '1jNGlbw1Qr6ckmfOe9eIqE3W1-qZllNEe'), -- ДИ ЕН ДИ 2021 ЕООД
  ('207558561', '1S8dsd4WZsrfzrG1ifRk3DnmP1ByyF9Mk'), -- ДРОСЕВ ОСТЕО КЕЪР ЕООД
  ('175323940', '1VtDWzmvAoWRDuk6y4gnApNM9W83MiNX2'), -- ЕЙНДЖЪЛ СТИЛ 2018
  ('208490832', '1_AHAKUSOxLqC8b8KfUmpnczhv_Z02skb'), -- ЕЛЕГИЯ ЕООД - 2025
  ('206965698', '14eknt2F_1dxmBHdh7vvprf6iQ5nCOv6h'), -- ЕМ ВИ ЕМ - О ЕООД
  ('181609063', '1Kmr3NTkoVjlY0HRdhIthSZ7eAQY1ySdL'), -- Йордан Дросев
  ('175324686', '1e5FsyyFEg1WugqwwLtaegboBd_PljsLP'), -- КОРЕКТ МУВЪРС ЕООД
  ('205970324', '1VuPs51W2_IkJPPWzxrTI6RU6bRwgQ3J0'), -- КОРЕКТ ОПАКОВКИ
  ('175124792', '1wS76AXZ01VhN1LBR1sU9Ngjfo_pGj1zg'), -- КОРЕКТ ПРЕМЕСТВАНЕ  ООД
  ('203731973', '1CqTp7mrMFhtvaduvuOBMcFwrxspYPxii'), -- МЕЙЛТЕМИ ЕООД
  ('204242946', '1t-bHYlq6ZHpCejnJJ2kbCArIv4Wr1KzJ'), -- МЕНИ МОР ЕООД
  ('204406662', '1Ct3lqEJIkP8FYfhojIQLQLu8EjYegSsK'), -- МЕХОВ КОНСУЛТ ЕООД 2017
  ('208199054', '12Uk6z7xooIgIrb1lgCJcOZ6xhC71GIM1'), -- МЕХОВИ АУТО
  ('200988973', '1RUwXxZw5c_z1FZ6PpzIQbdnJLLQy7uoD'), -- НЮ АКТЪРС ЕООД
  ('204308061', '1sj4gMIT3Xq57uup3qjE6Guh6yUdheofv'), -- ПЕНТАНОИ ЕООД (в Органайзера: Петанои)
  ('204549087', '1e2wrbGfBfh6pS-WHUGxAhlJO3uPF6-Fr'), -- ПП Албена Експрес ЕООД 2017
  ('202990987', '1k51pDk87eeDrMl0yhoasI8gS3XKSG5u9'), -- СКРИЙН БОКС ООД
  ('204906055', '1e03qWb3ohrDpjt80rS4Cj6yYMqlpRlAx'), -- СМАРТ ЪП ЕООД
  ('207495335', '1AG3ThL9ctNoGmqbe_ssklEpABlWevaE8'), -- ТехСиМикро ЕООД
  ('207526342', '1CAHoJHv9Oiceuv5Uk96oaVwb-aj1YNV5'), -- ТМТ АЛАЯНС ЕООД
  ('205782817', '1FDWhDhyPky_LxxWjgmHoS7kB_rFp79c0'), -- ХЕГЕР 3 само СОЛ ТРЗ
  ('208132244', '1AxirWdf0PJe2XcOPPBetx3A3lYYEKrd3'), -- Хегер Лифт ЕООД
  ('208132109', '17MAXGX-x-ZU8aUxVx_tK0OXO6_VxEaOY')  -- ХЕГЕТОР ООД
) as v(eik, folder_id)
where c.eik_egn = v.eik;
