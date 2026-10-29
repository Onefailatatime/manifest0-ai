-- A deleted site walk is hidden from Locations but kept (photos, products, SDS stay in storage).
ALTER TABLE visits ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
