import { ProxmoxClient } from "@pve-vm-autoscaler/proxmox";
import type { ScalingPolicy } from "@pve-vm-autoscaler/shared";
import type { ProvisionedNode, ScaleProvisioner, StructuredLogger } from "./types.js";

export class ProxmoxProvisioner implements ScaleProvisioner {
  constructor(
    private readonly proxmox: ProxmoxClient,
    private readonly logger: StructuredLogger
  ) {}

  async createNode(policy: ScalingPolicy, reason: string): Promise<ProvisionedNode> {
    const safeReason = reason.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const name = `${policy.proxmox.vmNamePrefix}-${Date.now()}`;
    const startedAt = Date.now();

    this.logger.info({
      event: "proxmox.vm.create.started",
      policyId: policy.id,
      reason,
      vmName: name,
      targetNode: policy.proxmox.targetNode,
      templateVmId: policy.proxmox.templateVmId,
      cpuCores: policy.proxmox.cpuCores,
      memoryMb: policy.proxmox.memoryMb,
      diskGb: policy.proxmox.diskGb,
      linkedClone: policy.proxmox.linkedClone,
      startOnCreate: policy.proxmox.startOnCreate,
      pool: policy.proxmox.pool,
      storage: policy.proxmox.storage,
      tags: [...policy.proxmox.tags, "autoscaled", safeReason].filter(Boolean)
    }, "Proxmox VM creation started");

    const result = await this.proxmox.createVmFromTemplate({
      targetNode: policy.proxmox.targetNode,
      templateVmId: policy.proxmox.templateVmId,
      name,
      cpuCores: policy.proxmox.cpuCores,
      memoryMb: policy.proxmox.memoryMb,
      diskGb: policy.proxmox.diskGb,
      pool: policy.proxmox.pool,
      storage: policy.proxmox.storage,
      linkedClone: policy.proxmox.linkedClone,
      startOnCreate: policy.proxmox.startOnCreate,
      tags: [...policy.proxmox.tags, "autoscaled", safeReason].filter(Boolean)
    });

    this.logger.info({
      event: "proxmox.vm.create.succeeded",
      policyId: policy.id,
      vmName: name,
      vmId: result.vmId,
      cloneTaskId: result.cloneTaskId,
      startTaskId: result.startTaskId,
      dryRun: result.dryRun,
      durationMs: Date.now() - startedAt
    }, "Proxmox VM creation succeeded");

    return {
      vmId: result.vmId,
      taskId: result.startTaskId ?? result.cloneTaskId,
      dryRun: result.dryRun
    };
  }
}
