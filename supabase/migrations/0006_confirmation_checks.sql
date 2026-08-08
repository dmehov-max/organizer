-- ============================================================
-- Органайзер — входящ номер на потвърждението + проверки за
-- дублиран номер и сгрешена фирма (SPEC.md §4).
-- ============================================================

alter table attachments
  add column recognized_reference_number text,
  add column recognized_client_name text,   -- името на фирмата, както го чете документът
  add column client_name_mismatch boolean not null default false,
  add column duplicate_of_attachment_id uuid references attachments(id);

create index idx_attachments_reference_number on attachments(recognized_reference_number)
  where recognized_reference_number is not null;
