import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import type { MetricSnapshot, NodeIdentity } from "@pve-vm-autoscaler/shared";

const execFileAsync = promisify(execFile);

const MEMINFO_PATH = "/proc/meminfo";

/** Сколько памяти всего и сколько реально доступно приложениям. */
export interface MemoryReading {
  totalBytes: number;
  availableBytes: number;
}

interface CpuTimes {
  idle: number;
  total: number;
}

function readCpuTimes(): CpuTimes {
  return os.cpus().reduce<CpuTimes>(
    (acc, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, time) => sum + time, 0);
      return {
        idle: acc.idle + cpu.times.idle,
        total: acc.total + total
      };
    },
    { idle: 0, total: 0 }
  );
}

async function readCpuUsagePercent(): Promise<number> {
  const before = readCpuTimes();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = readCpuTimes();

  const idleDelta = after.idle - before.idle;
  const totalDelta = after.total - before.total;
  if (totalDelta <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

async function readDiskUsage(mountPoint: string): Promise<MetricSnapshot["disk"]> {
  const { stdout } = await execFileAsync("df", ["-kP", mountPoint]);
  const [, line] = stdout.trim().split("\n");
  if (!line) {
    throw new Error(`Unable to read disk usage for ${mountPoint}`);
  }

  const parts = line.replace(/\s+/g, " ").split(" ");
  const totalKb = Number(parts[1]);
  const usedKb = Number(parts[2]);

  return {
    mountPoint,
    totalBytes: totalKb * 1024,
    usedBytes: usedKb * 1024,
    usagePercent: totalKb > 0 ? (usedKb / totalKb) * 100 : 0
  };
}

/**
 * Разбирает содержимое `/proc/meminfo` и достаёт `MemTotal` и `MemAvailable`.
 *
 * Именно `MemAvailable`, а не `MemFree`: ядро считает в нём память, которую можно
 * отдать приложению без свопа, включая page cache и reclaimable-слэб. `MemFree`
 * учитывает только никем не занятые страницы, поэтому на прогретой машине он близок
 * к нулю, хотя памяти в реальности достаточно.
 *
 * @param content Сырое содержимое `/proc/meminfo`.
 * @returns Показания или `undefined`, если нужных полей нет
 *   (например, ядро старше 3.14 — там `MemAvailable` ещё не было).
 */
export function parseMemInfo(content: string): MemoryReading | undefined {
  let totalKb: number | undefined;
  let availableKb: number | undefined;

  for (const line of content.split("\n")) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s*kB$/.exec(line.trim());
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (!key || !rawValue) {
      continue;
    }

    if (key === "MemTotal") {
      totalKb = Number(rawValue);
    } else {
      availableKb = Number(rawValue);
    }
  }

  if (totalKb === undefined || availableKb === undefined) {
    return undefined;
  }

  // /proc/meminfo размечает значения как kB, но это кибибайты — 1024 байта.
  return {
    totalBytes: totalKb * 1024,
    availableBytes: availableKb * 1024
  };
}

/**
 * Переводит показания памяти в поле `memory` контракта метрик.
 *
 * @param reading Всего и доступно, в байтах.
 * @returns Занято в байтах и процент использования, ограниченный диапазоном 0..100.
 * @throws Ничего не бросает: некорректные значения приводятся к границам,
 *   иначе Zod-схема на сервере отвергла бы снимок целиком.
 */
export function toMemoryUsage(reading: MemoryReading): MetricSnapshot["memory"] {
  const totalBytes = Math.max(0, reading.totalBytes);
  const usedBytes = Math.max(0, totalBytes - Math.max(0, reading.availableBytes));

  return {
    totalBytes,
    usedBytes,
    usagePercent: totalBytes > 0 ? Math.min(100, (usedBytes / totalBytes) * 100) : 0
  };
}

/**
 * Снимает текущее использование памяти.
 *
 * На Linux читает `/proc/meminfo`. Если файла нет, он нечитаем или в нём отсутствует
 * `MemAvailable`, откатывается на `os.totalmem()`/`os.freemem()` — это менее точно
 * (`os.freemem()` на Linux отдаёт как раз `MemFree`), но лучше, чем отсутствие метрики.
 *
 * @returns Поле `memory` для снимка метрик.
 */
export async function readMemoryUsage(): Promise<MetricSnapshot["memory"]> {
  const reading = await readMemInfo();

  return toMemoryUsage(
    reading ?? {
      totalBytes: os.totalmem(),
      availableBytes: os.freemem()
    }
  );
}

async function readMemInfo(): Promise<MemoryReading | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }

  try {
    return parseMemInfo(await readFile(MEMINFO_PATH, "utf8"));
  } catch {
    // Файл может быть недоступен в урезанном контейнере — тогда работает fallback.
    return undefined;
  }
}

export async function collectMetricSnapshot(
  node: NodeIdentity,
  mountPoint: string
): Promise<MetricSnapshot> {
  const [cpuPercent, disk, memory] = await Promise.all([
    readCpuUsagePercent(),
    readDiskUsage(mountPoint),
    readMemoryUsage()
  ]);

  return {
    node,
    collectedAt: new Date().toISOString(),
    uptimeSeconds: os.uptime(),
    cpu: {
      usagePercent: cpuPercent,
      loadAverage: os.loadavg()
    },
    memory,
    disk
  };
}
