import "dotenv/config";
import type { ResolvedScalingPolicy } from "@pve-vm-autoscaler/shared";
import { loadPolicyFile } from "./policyLoader.js";

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  agentToken: string;
  evaluationIntervalMs: number;
  policies: ResolvedScalingPolicy[];
  proxmox: {
    dryRun: boolean;
    baseUrl: string;
    tokenId: string;
    tokenSecret: string;
    tlsRejectUnauthorized: boolean;
  };
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = env.DATABASE_URL;
  const agentToken = env.AGENT_TOKEN;
  const policyFile = env.POLICY_FILE ?? "./infra/policy.example.yaml";

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  if (!agentToken) {
    throw new Error("AGENT_TOKEN is required");
  }

  return {
    host: env.SERVER_HOST ?? "0.0.0.0",
    port: Number(env.SERVER_PORT ?? 8080),
    databaseUrl,
    agentToken,
    evaluationIntervalMs: Number(env.EVALUATION_INTERVAL_MS ?? 15_000),
    policies: loadPolicyFile(policyFile),
    proxmox: {
      dryRun: env.PROXMOX_DRY_RUN !== "false",
      baseUrl: env.PROXMOX_BASE_URL ?? "",
      tokenId: env.PROXMOX_TOKEN_ID ?? "",
      tokenSecret: env.PROXMOX_TOKEN_SECRET ?? "",
      tlsRejectUnauthorized: env.PROXMOX_TLS_REJECT_UNAUTHORIZED !== "false"
    }
  };
}
