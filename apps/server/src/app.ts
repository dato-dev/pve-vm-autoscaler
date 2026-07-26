import fastify from "fastify";
import type { ServerConfig } from "./config/env.js";
import { AutoscalerRepository } from "./db/repository.js";
import type { DatabasePool } from "./db/pool.js";
import { registerMetricsRoutes } from "./routes/metrics.js";

export interface BuildAppOptions {
  config: ServerConfig;
  pool: DatabasePool;
}

export async function buildApp(options: BuildAppOptions) {
  const app = fastify({
    logger: true
  });

  const repository = new AutoscalerRepository(options.pool);

  app.get("/health", async () => ({
    ok: true,
    service: "pve-vm-autoscaler-server"
  }));

  await registerMetricsRoutes(app, {
    repository,
    agentToken: options.config.agentToken
  });

  return {
    app,
    repository
  };
}
