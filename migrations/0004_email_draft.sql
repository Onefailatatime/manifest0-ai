-- The email as the technician reviewed and edited it before sending (null = use the default text).
ALTER TABLE visits ADD COLUMN email_subject TEXT;
ALTER TABLE visits ADD COLUMN email_message TEXT;
