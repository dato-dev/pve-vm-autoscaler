import os from "node:os";
import { MetricsClient } from "./client.js";
import { loadAgentConfig } from "./config.js";
import { collectMetricSnapshot } from "./metrics.js";

const AGENT_VERSION = "0.1.0";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = loadAgentConfig();
  const client = new MetricsClient({
    serverUrl: config.serverUrl,
    token: config.token
  });

  const node = {
    nodeId: config.nodeId,
    hostname: os.hostname(),
    agentVersion: AGENT_VERSION,
    labels: config.labels
  };

  let consecutiveFailures = 0;
  console.log(`pve-vm-autoscaler agent started for ${node.nodeId}`);

  while (true) {
    try {
      const snapshot = await collectMetricSnapshot(node, config.mountPoint);
      await client.send(snapshot);
      consecutiveFailures = 0;
      console.log(
        `metrics sent cpu=${snapshot.cpu.usagePercent.toFixed(1)} memory=${snapshot.memory.usagePercent.toFixed(1)} disk=${snapshot.disk.usagePercent.toFixed(1)}`
      );
      await sleep(config.intervalMs);
    } catch (error) {
      consecutiveFailures += 1;
      const backoffMs = Math.min(config.intervalMs * consecutiveFailures, 60_000);
      console.error(error);
      await sleep(backoffMs);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
