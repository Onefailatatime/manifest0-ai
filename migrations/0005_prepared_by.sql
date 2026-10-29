-- Who prepared the walk, as shown on the report (instead of just their email).
ALTER TABLE visits ADD COLUMN prepared_by TEXT;
ALTER TABLE visits ADD COLUMN company TEXT;
