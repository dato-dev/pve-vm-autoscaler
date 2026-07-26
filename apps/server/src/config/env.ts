import "dotenv/config";
import { readFileSync } from "node:fs";
import { scalingPolicySchema, type ScalingPolicy } from "@pve-vm-autoscaler/shared";

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  agentToken: string;
  evaluationIntervalMs: number;
  policies: ScalingPolicy[];
  proxmox: {
    dryRun: boolean;
    baseUrl: string;
    tokenId: string;
    tokenSecret: string;
    tlsRejectUnauthorized: boolean;
  };
}

function loadPolicies(policyFile: string): ScalingPolicy[] {
  const raw = JSON.parse(readFileSync(policyFile, "utf8")) as unknown;
  const policies = Array.isArray(raw) ? raw : [raw];
  return policies.map((policy) => scalingPolicySchema.parse(policy));
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = env.DATABASE_URL;
  const agentToken = env.AGENT_TOKEN;
  const policyFile = env.POLICY_FILE ?? "./infra/policy.example.json";

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
    policies: loadPolicies(policyFile),
    proxmox: {
      dryRun: env.PROXMOX_DRY_RUN !== "false",
      baseUrl: env.PROXMOX_BASE_URL ?? "",
      tokenId: env.PROXMOX_TOKEN_ID ?? "",
      tokenSecret: env.PROXMOX_TOKEN_SECRET ?? "",
      tlsRejectUnauthorized: env.PROXMOX_TLS_REJECT_UNAUTHORIZED !== "false"
    }
  };
}
