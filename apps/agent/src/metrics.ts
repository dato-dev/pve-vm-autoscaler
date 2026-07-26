import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { MetricSnapshot, NodeIdentity } from "@pve-vm-autoscaler/shared";

const execFileAsync = promisify(execFile);

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

export async function collectMetricSnapshot(
  node: NodeIdentity,
  mountPoint: string
): Promise<MetricSnapshot> {
  const [cpuPercent, disk] = await Promise.all([
    readCpuUsagePercent(),
    readDiskUsage(mountPoint)
  ]);

  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;

  return {
    node,
    collectedAt: new Date().toISOString(),
    uptimeSeconds: os.uptime(),
    cpu: {
      usagePercent: cpuPercent,
      loadAverage: os.loadavg()
    },
    memory: {
      totalBytes: totalMemory,
      usedBytes: usedMemory,
      usagePercent: totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0
    },
    disk
  };
}
