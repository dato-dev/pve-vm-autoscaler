import { randomUUID } from "node:crypto";
import type { MetricSnapshot, NodeLabels, ScalingDecision } from "@pve-vm-autoscaler/shared";
import type { DatabasePool } from "./pool.js";

export interface WindowAverages {
  observedNodes: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
}

export interface ScalingEventRecord {
  id: string;
  /** Имя политики. В БД хранится в колонке policy_id — колонку не переименовываем. */
  policyName: string;
  status: string;
  reason: string;
  proxmoxTaskId?: string;
  createdVmId?: number;
}

export class AutoscalerRepository {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * Сохраняет снимок метрик: upsert ноды и вставку строки метрик одной транзакцией.
   *
   * Оба запроса идут по ОДНОМУ соединению, взятому через `pool.connect()`.
   * Через `pool.query()` так делать нельзя: пул выдаёт соединение на каждый вызов
   * заново, поэтому BEGIN, INSERT и COMMIT могут уйти в разные соединения. Транзакции
   * в этом случае нет вообще, а соединение с незакрытым BEGIN возвращается в пул
   * грязным (`idle in transaction`) — оно держит блокировки и со временем исчерпывает пул.
   *
   * @param snapshot Валидированный снимок метрик от агента.
   * @throws Ошибку любого из запросов — предварительно откатив транзакцию и вернув соединение.
   */
  async saveMetric(snapshot: MetricSnapshot): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `
        INSERT INTO nodes (node_id, hostname, agent_version, labels, last_seen_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (node_id) DO UPDATE SET
          hostname = EXCLUDED.hostname,
          agent_version = EXCLUDED.agent_version,
          labels = EXCLUDED.labels,
          last_seen_at = EXCLUDED.last_seen_at,
          updated_at = now()
        `,
        [
          snapshot.node.nodeId,
          snapshot.node.hostname,
          snapshot.node.agentVersion ?? null,
          JSON.stringify(snapshot.node.labels),
          snapshot.collectedAt
        ]
      );

      await client.query(
        `
        INSERT INTO metrics (
          time,
          node_id,
          cpu_percent,
          memory_percent,
          memory_total_bytes,
          memory_used_bytes,
          disk_percent,
          disk_total_bytes,
          disk_used_bytes,
          disk_mount_point,
          uptime_seconds,
          raw
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (time, node_id) DO NOTHING
        `,
        [
          snapshot.collectedAt,
          snapshot.node.nodeId,
          snapshot.cpu.usagePercent,
          snapshot.memory.usagePercent,
          snapshot.memory.totalBytes,
          snapshot.memory.usedBytes,
          snapshot.disk.usagePercent,
          snapshot.disk.totalBytes,
          snapshot.disk.usedBytes,
          snapshot.disk.mountPoint,
          snapshot.uptimeSeconds,
          JSON.stringify(snapshot)
        ]
      );

      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Соединение могло уже оборваться — тогда откат не пройдёт.
        // Ошибка отката не должна подменять причину сбоя: наружу уходит исходная.
      }
      throw error;
    } finally {
      // release() обязателен в любом исходе, иначе соединение утечёт из пула.
      client.release();
    }
  }

  /**
   * Считает среднюю нагрузку по нодам, подходящим под селектор, за окно оценки.
   *
   * Агрегация двухуровневая: сначала среднее по каждой ноде, затем среднее по нодам.
   * Плоский `avg()` по всем строкам взвешивал бы ноды по количеству присланных сэмплов —
   * нода, поднявшаяся 20 секунд назад, дала бы пару строк, а работающая час — десятки,
   * и решение принималось бы в основном по старожилам.
   *
   * **Выбор статистики.** Берётся среднее арифметическое по нодам. Это осознанный
   * компромисс, корректный для однородного пула с равномерно распределяемой работой.
   * Среднее прячет перекос: одна нода на 100% и три на 20% дают 40%, и порог 80%
   * не сработает, хотя одна машина уже стоит колом. Альтернативы (доля нод выше порога,
   * p95) лежат в бэклоге ROADMAP — менять статистику нужно вместе с формой политики,
   * иначе оператор не сможет выразить, чего он хочет.
   *
   * `null` в средних означает «данных нет», а не «нагрузка нулевая»:
   * `evaluateScalingDecision` различает эти случаи и на `null` не масштабирует.
   *
   * @param labels Метки из `selector` политики.
   * @param windowSeconds Ширина окна оценки в секундах.
   * @returns Средние по нодам и число нод, приславших хотя бы один сэмпл в окне.
   */
  async getWindowAverages(labels: NodeLabels, windowSeconds: number): Promise<WindowAverages> {
    const result = await this.pool.query<{
      observed_nodes: string;
      cpu_percent: number | null;
      memory_percent: number | null;
      disk_percent: number | null;
    }>(
      `
      WITH per_node AS (
        SELECT
          metrics.node_id,
          avg(metrics.cpu_percent) AS cpu_percent,
          avg(metrics.memory_percent) AS memory_percent,
          avg(metrics.disk_percent) AS disk_percent
        FROM metrics
        JOIN nodes ON nodes.node_id = metrics.node_id
        WHERE metrics.time >= now() - ($1::int * interval '1 second')
          AND nodes.labels @> $2::jsonb
        GROUP BY metrics.node_id
      )
      SELECT
        count(*) AS observed_nodes,
        avg(cpu_percent) AS cpu_percent,
        avg(memory_percent) AS memory_percent,
        avg(disk_percent) AS disk_percent
      FROM per_node
      `,
      [windowSeconds, JSON.stringify(labels)]
    );

    const row = result.rows[0];
    return {
      observedNodes: Number(row?.observed_nodes ?? 0),
      cpuPercent: row?.cpu_percent === null || row?.cpu_percent === undefined ? null : Number(row.cpu_percent),
      memoryPercent: row?.memory_percent === null || row?.memory_percent === undefined ? null : Number(row.memory_percent),
      diskPercent: row?.disk_percent === null || row?.disk_percent === undefined ? null : Number(row.disk_percent)
    };
  }

  /**
   * Считает ноды, которые подходят под селектор политики и продолжают присылать метрики.
   *
   * Фильтрация выполняется в SQL: `labels @> $1::jsonb` использует GIN-индекс
   * `nodes_labels_idx`, тогда как прежняя реализация выгружала всю таблицу `nodes`
   * в память и фильтровала в JS.
   *
   * Порог свежести намеренно равен окну оценки нагрузки. Иначе счётчик и средние
   * расходятся: отвалившаяся нода перестаёт давать сэмплы и уходит из среднего,
   * но продолжает занимать место в лимите `maxNodes`. Отказ ноды в этом случае
   * подавляет масштабирование вместо того, чтобы вызывать его.
   *
   * Осмысленно только при окне, заметно большем интервала отправки метрик агентом;
   * при слишком коротком окне и средние, и этот счётчик одинаково нестабильны.
   *
   * @param labels Метки из `selector` политики. Пустой объект совпадает со всеми нодами.
   * @param freshWithinSeconds Окно свежести в секундах: нода считается живой,
   *   если её `last_seen_at` попадает в этот интервал.
   * @returns Количество живых нод, подходящих под селектор.
   */
  async countKnownNodes(labels: NodeLabels, freshWithinSeconds: number): Promise<number> {
    const result = await this.pool.query<{ known_nodes: string }>(
      `
      SELECT count(*) AS known_nodes
      FROM nodes
      WHERE labels @> $1::jsonb
        AND last_seen_at >= now() - ($2::int * interval '1 second')
      `,
      [JSON.stringify(labels), freshWithinSeconds]
    );

    return Number(result.rows[0]?.known_nodes ?? 0);
  }

  async getLastScalingEvent(policyName: string, cooldownSeconds: number): Promise<ScalingEventRecord | null> {
    const result = await this.pool.query<{
      id: string;
      policy_id: string;
      status: string;
      reason: string;
      proxmox_task_id: string | null;
      created_vm_id: number | null;
    }>(
      `
      SELECT id, policy_id, status, reason, proxmox_task_id, created_vm_id
      FROM scaling_events
      WHERE policy_id = $1
        AND created_at >= now() - ($2::int * interval '1 second')
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [policyName, cooldownSeconds]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      policyName: row.policy_id,
      status: row.status,
      reason: row.reason,
      proxmoxTaskId: row.proxmox_task_id ?? undefined,
      createdVmId: row.created_vm_id ?? undefined
    };
  }

  async createScalingEvent(decision: ScalingDecision, status: string): Promise<ScalingEventRecord> {
    const id = randomUUID();
    await this.pool.query(
      `
      INSERT INTO scaling_events (id, policy_id, status, reason, decision)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [id, decision.policyName, status, decision.reason, JSON.stringify(decision)]
    );

    return {
      id,
      policyName: decision.policyName,
      status,
      reason: decision.reason
    };
  }

  async updateScalingEvent(
    id: string,
    status: string,
    proxmoxTaskId?: string,
    createdVmId?: number
  ): Promise<void> {
    await this.pool.query(
      `
      UPDATE scaling_events
      SET status = $2,
          proxmox_task_id = COALESCE($3, proxmox_task_id),
          created_vm_id = COALESCE($4, created_vm_id),
          completed_at = CASE WHEN $2 IN ('succeeded', 'failed', 'dry_run') THEN now() ELSE completed_at END
      WHERE id = $1
      `,
      [id, status, proxmoxTaskId ?? null, createdVmId ?? null]
    );
  }
}
