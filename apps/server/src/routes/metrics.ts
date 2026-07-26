import type { FastifyInstance } from "fastify";
import { metricSnapshotSchema } from "@pve-vm-autoscaler/shared";
import type { AutoscalerRepository } from "../db/repository.js";
import { createAgentAuthHook } from "../security/auth.js";

export interface MetricsRoutesOptions {
  repository: AutoscalerRepository;
  agentToken: string;
}

/**
 * Регистрирует приём метрик от агентов: `POST /v1/metrics`.
 *
 * Маршрут закрыт Bearer-токеном и отвечает `202`, потому что запись метрики —
 * приём к обработке, а не создание ресурса с адресом.
 *
 * @param app Экземпляр Fastify.
 * @param options Репозиторий для записи и ожидаемый токен агента.
 */
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
      // safeParse, а не parse: parse бросает ZodError, тот доходит до обработчика
      // ошибок Fastify и превращается в 500. Невалидный payload — ошибка клиента,
      // и агент должен получить 400, чтобы не ретраить заведомо битые данные вечно.
      const parsed = metricSnapshotSchema.safeParse(request.body);

      if (!parsed.success) {
        // Путь до поля отдаётся клиенту: без него владелец агента не поймёт,
        // что именно не так. Пользовательских данных в путях схемы нет.
        const issues = parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }));

        request.log.warn({
          event: "metrics.rejected",
          issueCount: issues.length,
          issues
        }, "metrics payload rejected");

        return reply.code(400).send({
          error: "invalid_metrics_payload",
          issues
        });
      }

      const snapshot = parsed.data;
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
