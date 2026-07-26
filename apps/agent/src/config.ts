import "dotenv/config";
import os from "node:os";
import type { NodeLabels } from "@pve-vm-autoscaler/shared";

export interface AgentConfig {
  nodeId: string;
  serverUrl: string;
  token: string;
  intervalMs: number;
  labels: NodeLabels;
  mountPoint: string;
}

function parseLabels(value: string | undefined): NodeLabels {
  if (!value) {
    return {};
  }

  return Object.fromEntries(
    value
      .split(",")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .flatMap((pair) => {
        const separatorIndex = pair.indexOf("=");
        if (separatorIndex <= 0) {
          return [];
        }

        const key = pair.slice(0, separatorIndex).trim();
        const labelValue = pair.slice(separatorIndex + 1).trim();
        return key && labelValue ? [[key, labelValue] as const] : [];
      })
  );
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const serverUrl = env.AGENT_SERVER_URL ?? "http://localhost:8080";
  const token = env.AGENT_TOKEN;

  if (!token) {
    throw new Error("AGENT_TOKEN is required");
  }

  return {
    nodeId: env.AGENT_NODE_ID ?? os.hostname(),
    serverUrl: serverUrl.replace(/\/$/, ""),
    token,
    intervalMs: Number(env.AGENT_INTERVAL_MS ?? 10_000),
    labels: parseLabels(env.AGENT_LABELS),
    mountPoint: env.AGENT_MOUNT_POINT ?? "/"
  };
}
