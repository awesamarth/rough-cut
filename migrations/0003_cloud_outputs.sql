CREATE TABLE cloud_outputs (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  filename TEXT NOT NULL,
  max_bytes INTEGER NOT NULL,
  bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'uploading',
  downloads INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE cloud_output_parts (
  output_id TEXT NOT NULL REFERENCES cloud_outputs(id) ON DELETE CASCADE,
  part INTEGER NOT NULL,
  bytes INTEGER,
  PRIMARY KEY (output_id, part)
);
