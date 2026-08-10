-- ============================================================
-- Органайзер — best-effort сума на ДДС (за внасяне/възстановяване),
-- прочетена от DEKLAR.txt при откриване в Drive (check-drive-files).
-- Само за справка/преглед — НЕ е авторитетен източник (виж
-- коментара при parseDeklarVatAmount() за двойната самопроверка,
-- която трябва да мине, преди изобщо да се запише число тук).
-- ============================================================

alter table tasks
  add column drive_detected_vat_amount numeric(14,2),
  add column drive_detected_vat_direction text check (drive_detected_vat_direction in ('due', 'refund'));
