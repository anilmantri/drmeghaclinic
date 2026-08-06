-- Dr. Megha's Skin Scan — leads table
-- Apply with: wrangler d1 execute drmegha-leads --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  city TEXT NOT NULL,
  age INTEGER,
  report_summary TEXT,
  suggested_focus_areas TEXT,
  source TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at DESC);
