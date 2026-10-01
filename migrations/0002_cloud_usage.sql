-- Global admission counters, not billing telemetry. Failed calls retain their reservation.
CREATE TABLE cloud_usage (
  day TEXT NOT NULL,
  operation TEXT NOT NULL,
  units INTEGER NOT NULL CHECK (units >= 0),
  requests INTEGER NOT NULL CHECK (requests >= 0),
  PRIMARY KEY (day, operation)
);

-- Admission/expiry only; output files and execution status remain temporary in the Container.
-- Unknown/expired job IDs must be rejected without waking paid infrastructure.
CREATE TABLE cloud_jobs (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
