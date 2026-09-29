CREATE TABLE IF NOT EXISTS players (
  uuid TEXT NOT NULL PRIMARY KEY,
  server TEXT NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_server ON players(server);
