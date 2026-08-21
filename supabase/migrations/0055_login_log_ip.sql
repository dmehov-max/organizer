-- IP адрес на всеки вход — база за "поискай 2FA само от нова IP",
-- поискано изрично 2026-08-20. Продължение на 0053/0054.
alter table login_log add column ip_address text;
