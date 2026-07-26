import { loadServerConfig } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { buildApp } from "./app.js";
import { ProxmoxClient } from "@pve-vm-autoscaler/proxmox";
import { ProxmoxProvisioner } from "./evaluator/proxmoxProvisioner.js";
import { ScalingEvaluator } from "./evaluator/worker.js";

async function main(): Promise<void> {
  const config = loadServerConfig();
  await runMigrations(config.databaseUrl);

  const pool = createPool(config.databaseUrl);
  const { app, repository } = await buildApp({ config, pool });
  const proxmox = new ProxmoxClient({
    ...config.proxmox,
    logger: app.log
  });
  const evaluator = new ScalingEvaluator({
    repository,
    policies: config.policies,
    provisioner: new ProxmoxProvisioner(proxmox, app.log),
    intervalMs: config.evaluationIntervalMs,
    logger: app.log
  });
  evaluator.start();

  const shutdown = async () => {
    evaluator.stop();
    await app.close();
    await pool.end();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({
    host: config.host,
    port: config.port
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
