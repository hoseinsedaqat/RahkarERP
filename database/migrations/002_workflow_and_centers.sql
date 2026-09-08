-- جداول گردش کار، مراکز هزینه و تکمیل دوره‌های مالی
ALTER TABLE fiscal_periods ADD COLUMN IF NOT EXISTS year smallint;
ALTER TABLE fiscal_periods ADD COLUMN IF NOT EXISTS period_index smallint;

CREATE TABLE IF NOT EXISTS cost_centers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code varchar(40) NOT NULL,
  title varchar(160) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  number bigint NOT NULL,
  title varchar(300) NOT NULL,
  module varchar(60) NOT NULL,
  amount numeric(20,2) NOT NULL DEFAULT 0,
  priority varchar(20) NOT NULL DEFAULT 'normal',
  status varchar(30) NOT NULL DEFAULT 'draft',
  fiscal_period_id uuid REFERENCES fiscal_periods(id),
  cost_center_id uuid REFERENCES cost_centers(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, number)
);

CREATE TABLE IF NOT EXISTS document_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  actor varchar(80) NOT NULL,
  action varchar(40) NOT NULL,
  from_status varchar(30),
  to_status varchar(30) NOT NULL,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_document_history_document ON document_history (document_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_periods_title ON fiscal_periods (organization_id, title);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_centers_code ON cost_centers (organization_id, code);
