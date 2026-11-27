-- Preserve the registration mail transport used before smtp_secure was honored.
-- Port 465 used implicit TLS; all other legacy port choices used STARTTLS.
UPDATE instance_settings
SET smtp_secure = CASE WHEN smtp_port = 465 THEN 1 ELSE 0 END
WHERE id = 'instance';
