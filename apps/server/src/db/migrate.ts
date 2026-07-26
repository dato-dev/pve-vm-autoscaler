import { createPool } from "./pool.js";

const migrationSql = `
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS nodes (
  node_id text PRIMARY KEY,
  hostname text NOT NULL,
  agent_version text,
  labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS metrics (
  time timestamptz NOT NULL,
  node_id text NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
  cpu_percent double precision NOT NULL,
  memory_percent double precision NOT NULL,
  memory_total_bytes bigint NOT NULL,
  memory_used_bytes bigint NOT NULL,
  disk_percent double precision NOT NULL,
  disk_total_bytes bigint NOT NULL,
  disk_used_bytes bigint NOT NULL,
  disk_mount_point text NOT NULL,
  uptime_seconds double precision NOT NULL,
  raw jsonb NOT NULL,
  PRIMARY KEY (time, node_id)
);

SELECT create_hypertable('metrics', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS metrics_node_time_idx ON metrics (node_id, time DESC);
CREATE INDEX IF NOT EXISTS nodes_labels_idx ON nodes USING gin (labels);

CREATE TABLE IF NOT EXISTS scaling_events (
  id text PRIMARY KEY,
  policy_id text NOT NULL,
  status text NOT NULL,
  reason text NOT NULL,
  decision jsonb NOT NULL,
  proxmox_task_id text,
  created_vm_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS scaling_events_policy_created_idx
  ON scaling_events (policy_id, created_at DESC);
`;

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await pool.query(migrationSql);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  await runMigrations(databaseUrl);
  console.log("database migrations applied");
}
