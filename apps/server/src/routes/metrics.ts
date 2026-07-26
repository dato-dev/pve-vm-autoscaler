import type { FastifyInstance } from "fastify";
import { metricSnapshotSchema } from "@pve-vm-autoscaler/shared";
import type { AutoscalerRepository } from "../db/repository.js";
import { createAgentAuthHook } from "../security/auth.js";

export interface MetricsRoutesOptions {
  repository: AutoscalerRepository;
  agentToken: string;
}

export async function registerMetricsRoutes(
  app: FastifyInstance,
  options: MetricsRoutesOptions
): Promise<void> {
  app.post(
    "/v1/metrics",
    {
      preHandler: createAgentAuthHook(options.agentToken)
    },
    async (request, reply) => {
      const snapshot = metricSnapshotSchema.parse(request.body);
      await options.repository.saveMetric(snapshot);
      request.log.info({
        event: "metrics.ingested",
        nodeId: snapshot.node.nodeId,
        hostname: snapshot.node.hostname,
        labels: snapshot.node.labels,
        collectedAt: snapshot.collectedAt,
        cpuPercent: snapshot.cpu.usagePercent,
        memoryPercent: snapshot.memory.usagePercent,
        diskPercent: snapshot.disk.usagePercent
      }, "metrics ingested");
      return reply.code(202).send({ accepted: true });
    }
  );
}
