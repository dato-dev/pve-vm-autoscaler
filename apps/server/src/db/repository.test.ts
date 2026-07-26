import { describe, expect, it } from "vitest";
import type { MetricSnapshot } from "@pve-vm-autoscaler/shared";
import { AutoscalerRepository } from "./repository.js";
import type { DatabasePool } from "./pool.js";

/** Запрос, записанный фейковым пулом: важно не только «что», но и «через какое соединение». */
interface RecordedQuery {
  /** Номер соединения; 0 означает запрос напрямую через пул, минуя connect(). */
  connectionId: number;
  sql: string;
  values: unknown[];
}

/**
 * Фейковый пул pg, фиксирующий, через какое соединение прошёл каждый запрос.
 *
 * Настоящий баг M1.2 состоял в том, что транзакция выполнялась через `pool.query()`,
 * а пул выдаёт соединение на каждый вызов заново. Поэтому проверять надо не порядок
 * SQL, а именно принадлежность запросов одному соединению — на это и заточен фейк.
 */
class FakePool {
  readonly queries: RecordedQuery[] = [];
  readonly releasedConnections: number[] = [];
  private nextConnectionId = 1;

  /** SQL-фрагмент, на котором запрос должен упасть, и ошибка, которую он бросит. */
  failOn?: { match: string; error: Error };

  /** Строки, которые вернёт пул на запрос, содержащий указанный SQL-фрагмент. */
  respondWith: { match: string; rows: unknown[] }[] = [];

  async connect(): Promise<{
    query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
    release: () => void;
  }> {
    const connectionId = this.nextConnectionId++;

    return {
      query: async (sql: string, values: unknown[] = []) => {
        this.queries.push({ connectionId, sql, values });
        if (this.failOn && sql.includes(this.failOn.match)) {
          throw this.failOn.error;
        }
        return { rows: this.rowsFor(sql) };
      },
      release: () => {
        this.releasedConnections.push(connectionId);
      }
    };
  }

  /** Прямой вызов мимо connect(): так работают методы без транзакции. */
  async query(sql: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
    this.queries.push({ connectionId: 0, sql, values });
    if (this.failOn && sql.includes(this.failOn.match)) {
      throw this.failOn.error;
    }
    return { rows: this.rowsFor(sql) };
  }

  private rowsFor(sql: string): unknown[] {
    return this.respondWith.find((r) => sql.includes(r.match))?.rows ?? [];
  }

  /** Запросы транзакции: BEGIN/COMMIT/ROLLBACK и оба INSERT. */
  transactionQueries(): RecordedQuery[] {
    return this.queries.filter((q) => /BEGIN|COMMIT|ROLLBACK|INSERT/.test(q.sql));
  }
}

function buildSnapshot(): MetricSnapshot {
  return {
    node: {
      nodeId: "vm-1",
      hostname: "vm-1.lab",
      agentVersion: "0.1.0",
      labels: { role: "worker" }
    },
    collectedAt: "2026-07-26T10:00:00.000Z",
    uptimeSeconds: 3600,
    cpu: { usagePercent: 42, loadAverage: [1, 1, 1] },
    memory: { totalBytes: 2_147_483_648, usedBytes: 1_073_741_824, usagePercent: 50 },
    disk: {
      mountPoint: "/",
      totalBytes: 21_474_836_480,
      usedBytes: 5_368_709_120,
      usagePercent: 25
    }
  };
}

function buildRepository(pool: FakePool): AutoscalerRepository {
  // Фейк реализует только connect/query — то, чем пользуется репозиторий.
  return new AutoscalerRepository(pool as unknown as DatabasePool);
}

describe("AutoscalerRepository.saveMetric", () => {
  it("выполняет всю транзакцию на одном соединении", async () => {
    const pool = new FakePool();
    await buildRepository(pool).saveMetric(buildSnapshot());

    const transaction = pool.transactionQueries();
    const connectionIds = new Set(transaction.map((q) => q.connectionId));

    expect(connectionIds.size).toBe(1);
    // 0 означает pool.query() мимо connect() — ровно тот баг, который чиним.
    expect(connectionIds.has(0)).toBe(false);

    expect(transaction.map((q) => q.sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "BEGIN",
      "INSERT INTO nodes",
      "INSERT INTO metrics",
      "COMMIT"
    ]);
  });

  it("возвращает соединение в пул после успешного коммита", async () => {
    const pool = new FakePool();
    await buildRepository(pool).saveMetric(buildSnapshot());

    expect(pool.releasedConnections).toEqual([1]);
  });

  it("откатывает транзакцию и пробрасывает ошибку, не теряя соединение", async () => {
    const pool = new FakePool();
    const failure = new Error("insert into metrics failed");
    pool.failOn = { match: "INSERT INTO metrics", error: failure };

    await expect(buildRepository(pool).saveMetric(buildSnapshot())).rejects.toThrow(failure);

    const sql = pool.transactionQueries().map((q) => q.sql.trim().split(/\s+/)[0]);
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(pool.releasedConnections).toEqual([1]);
  });

  it("при падении самого ROLLBACK отдаёт исходную ошибку, а не ошибку отката", async () => {
    // Соединение оборвалось: INSERT упал, и добить его откатом уже не выйдет.
    // Наружу должна уйти причина сбоя, а не вторичная ошибка транспорта.
    const pool = new FakePool();
    const original = new Error("insert into metrics failed");
    pool.failOn = { match: "INSERT INTO metrics", error: original };

    const openConnection = pool.connect.bind(pool);
    pool.connect = async () => {
      const client = await openConnection();
      const query = client.query;
      client.query = async (sql: string, values?: unknown[]) => {
        if (sql.includes("ROLLBACK")) {
          throw new Error("connection terminated");
        }
        return query(sql, values);
      };
      return client;
    };

    await expect(buildRepository(pool).saveMetric(buildSnapshot())).rejects.toThrow(original);
    expect(pool.releasedConnections).toEqual([1]);
  });
});

describe("AutoscalerRepository.countKnownNodes", () => {
  /** Единственный запрос, отправленный в этом тесте. */
  function onlyQuery(pool: FakePool): RecordedQuery {
    expect(pool.queries).toHaveLength(1);
    const query = pool.queries[0];
    if (!query) {
      throw new Error("ожидался ровно один запрос");
    }
    return query;
  }

  it("фильтрует по меткам и свежести в SQL, а не в памяти", async () => {
    const pool = new FakePool();
    pool.respondWith = [{ match: "count(*)", rows: [{ known_nodes: "3" }] }];

    const count = await buildRepository(pool).countKnownNodes({ role: "worker" }, 120);

    const query = onlyQuery(pool);
    // Регрессия: раньше метод делал `SELECT node_id, labels FROM nodes` и фильтровал
    // результат в JS — вся таблица уезжала в память мимо GIN-индекса.
    expect(query.sql).toContain("labels @> $1::jsonb");
    expect(query.sql).toContain("last_seen_at >= now()");
    expect(query.values).toEqual([JSON.stringify({ role: "worker" }), 120]);
    expect(count).toBe(3);
  });

  it("не считает ноды, замолчавшие дольше окна", async () => {
    // Живых нод нет: все last_seen_at вне окна, count(*) вернёт 0.
    const pool = new FakePool();
    pool.respondWith = [{ match: "count(*)", rows: [{ known_nodes: "0" }] }];

    const count = await buildRepository(pool).countKnownNodes({ role: "worker" }, 60);

    expect(count).toBe(0);
    expect(onlyQuery(pool).values[1]).toBe(60);
  });

  it("пустой селектор превращается в jsonb {} и совпадает со всеми нодами", async () => {
    const pool = new FakePool();
    pool.respondWith = [{ match: "count(*)", rows: [{ known_nodes: "7" }] }];

    const count = await buildRepository(pool).countKnownNodes({}, 300);

    expect(onlyQuery(pool).values[0]).toBe("{}");
    expect(count).toBe(7);
  });

  it("возвращает 0, если строк нет вовсе", async () => {
    // Защита от падения на пустом result.rows — count(*) всегда даёт строку,
    // но полагаться на это без проверки нельзя (noUncheckedIndexedAccess).
    const pool = new FakePool();

    await expect(buildRepository(pool).countKnownNodes({ role: "worker" }, 120)).resolves.toBe(0);
  });

  it("пробрасывает ошибку базы, а не подменяет её нулём", async () => {
    const pool = new FakePool();
    const failure = new Error("connection terminated");
    pool.failOn = { match: "count(*)", error: failure };

    await expect(buildRepository(pool).countKnownNodes({ role: "worker" }, 120)).rejects.toThrow(
      failure
    );
  });
});
