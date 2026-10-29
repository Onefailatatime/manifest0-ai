-- Everyone the report goes to (JSON array). The first address is the technician (used as reply-to).
ALTER TABLE visits ADD COLUMN recipients TEXT NOT NULL DEFAULT '[]';

-- DOT shipping info, when the label shows it (or makes it obvious, e.g. bleach = Class 8 corrosive).
ALTER TABLE products ADD COLUMN hazard_class TEXT;   -- e.g. "8 (Corrosive)", "3 (Flammable liquid)"
ALTER TABLE products ADD COLUMN un_number TEXT;      -- e.g. "UN1791"

-- Technician review on the inventory screen.
ALTER TABLE products ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0; -- 1 = checked by the technician
ALTER TABLE products ADD COLUMN removed INTEGER NOT NULL DEFAULT 0;   -- 1 = not a real product / mistake: hidden and left out of the report.
                                                                     -- Kept (not deleted) so new photos of it are recognised and stay removed.
