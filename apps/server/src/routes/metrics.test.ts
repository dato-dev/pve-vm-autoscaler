import { describe, expect, it } from "vitest";
import type { MetricSnapshot } from "@pve-vm-autoscaler/shared";
import { buildApp } from "../app.js";
import type { ServerConfig } from "../config/env.js";
import type { DatabasePool } from "../db/pool.js";

const AGENT_TOKEN = "correct-horse-battery-staple";

/** Пул, который только запоминает выполненный SQL — нужен, чтобы отличить запись от её отсутствия. */
class RecordingPool {
  readonly sql: string[] = [];

  async connect(): Promise<{
    query: (text: string) => Promise<{ rows: unknown[] }>;
    release: () => void;
  }> {
    return {
      query: async (text: string) => {
        this.sql.push(text);
        return { rows: [] };
      },
      release: () => {}
    };
  }

  async query(text: string): Promise<{ rows: unknown[] }> {
    this.sql.push(text);
    return { rows: [] };
  }

  /** Была ли вставка метрики — то есть дошёл ли запрос до базы. */
  insertedMetrics(): boolean {
    return this.sql.some((text) => text.includes("INSERT INTO metrics"));
  }
}

function buildConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: "postgres://unused",
    agentToken: AGENT_TOKEN,
    evaluationIntervalMs: 15_000,
    policies: [],
    proxmox: {
      dryRun: true,
      baseUrl: "",
      tokenId: "",
      tokenSecret: "",
      tlsRejectUnauthorized: true
    }
  };
}

function validSnapshot(): MetricSnapshot {
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

async function buildTestApp(pool: RecordingPool) {
  return buildApp({
    config: buildConfig(),
    pool: pool as unknown as DatabasePool
  });
}

describe("POST /v1/metrics", () => {
  it("принимает валидный снимок и пишет его в базу", async () => {
    const pool = new RecordingPool();
    const { app } = await buildTestApp(pool);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/metrics",
        headers: { authorization: `Bearer ${AGENT_TOKEN}` },
        payload: validSnapshot()
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ accepted: true });
      expect(pool.insertedMetrics()).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("без токена отвечает 401 и НЕ доходит до базы", async () => {
    const pool = new RecordingPool();
    const { app } = await buildTestApp(pool);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/metrics",
        payload: validSnapshot()
      });

      expect(response.statusCode).toBe(401);
      // Суть регрессии: хук отвечал 401, но не обрывал жизненный цикл,
      // и обработчик всё равно записывал метрику неаутентифицированного клиента.
      expect(pool.insertedMetrics()).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("с чужим токеном отвечает 401 и не пишет в базу", async () => {
    const pool = new RecordingPool();
    const { app } = await buildTestApp(pool);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/metrics",
        headers: { authorization: "Bearer wrong-token" },
        payload: validSnapshot()
      });

      expect(response.statusCode).toBe(401);
      expect(pool.insertedMetrics()).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("на невалидный payload отвечает 400 с путём до поля, а не 500", async () => {
    const pool = new RecordingPool();
    const { app } = await buildTestApp(pool);

    try {
      const broken = validSnapshot();
      // 150% загрузки CPU не проходит z.number().max(100).
      broken.cpu.usagePercent = 150;

      const response = await app.inject({
        method: "POST",
        url: "/v1/metrics",
        headers: { authorization: `Bearer ${AGENT_TOKEN}` },
        payload: broken
      });

      expect(response.statusCode).toBe(400);

      const body = response.json();
      expect(body.error).toBe("invalid_metrics_payload");
      expect(body.issues.map((issue: { path: string }) => issue.path)).toContain(
        "cpu.usagePercent"
      );
      expect(pool.insertedMetrics()).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("на payload без обязательных полей отвечает 400", async () => {
    const pool = new RecordingPool();
    const { app } = await buildTestApp(pool);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/metrics",
        headers: { authorization: `Bearer ${AGENT_TOKEN}` },
        payload: { node: { nodeId: "vm-1" } }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().issues.length).toBeGreaterThan(0);
      expect(pool.insertedMetrics()).toBe(false);
    } finally {
      await app.close();
    }
  });
});
