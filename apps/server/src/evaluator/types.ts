import type { ScalingPolicy } from "@pve-vm-autoscaler/shared";

export interface ProvisionedNode {
  vmId?: number;
  taskId?: string;
  dryRun: boolean;
}

export interface StructuredLogger {
  debug(data: Record<string, unknown>, message?: string): void;
  info(data: Record<string, unknown>, message?: string): void;
  warn(data: Record<string, unknown>, message?: string): void;
  error(data: Record<string, unknown>, message?: string): void;
}

export interface ScaleProvisioner {
  createNode(policy: ScalingPolicy, reason: string): Promise<ProvisionedNode>;
}
