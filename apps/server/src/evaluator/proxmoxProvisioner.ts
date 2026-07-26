import { ProxmoxClient } from "@pve-vm-autoscaler/proxmox";
import type { ResolvedScalingPolicy } from "@pve-vm-autoscaler/shared";
import type { ProvisionedNode, ScaleProvisioner, StructuredLogger } from "./types.js";

/** Создаёт VM в Proxmox по шаблону машины, привязанному к политике. */
export class ProxmoxProvisioner implements ScaleProvisioner {
  constructor(
    private readonly proxmox: ProxmoxClient,
    private readonly logger: StructuredLogger
  ) {}

  /**
   * Клонирует VM из шаблона политики.
   *
   * @param policy Политика с уже подставленным шаблоном: величины переведены в единицы Proxmox.
   * @param reason Причина решения — попадает в тег VM, чтобы происхождение машины было видно в UI.
   * @returns Идентификаторы созданной VM и задачи Proxmox.
   * @throws Пробрасывает ошибку Proxmox API; вызывающий переводит scaling event в failed.
   */
  async createNode(policy: ResolvedScalingPolicy, reason: string): Promise<ProvisionedNode> {
    const template = policy.template;
    // Теги Proxmox не принимают произвольные символы, поэтому причина приводится к слагу.
    const safeReason = reason.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const name = `${template.namePrefix}-${Date.now()}`;
    const tags = [...template.tags, "autoscaled", safeReason].filter(Boolean);
    const startedAt = Date.now();

    this.logger.info({
      event: "proxmox.vm.create.started",
      policyName: policy.name,
      templateName: template.name,
      reason,
      vmName: name,
      hypervisor: template.hypervisor,
      templateVmId: template.templateVmId,
      cpu: template.cpu,
      memoryMib: template.memoryMib,
      diskSize: template.diskSize,
      diskDevice: template.diskDevice,
      linkedClone: template.linkedClone,
      startOnCreate: template.startOnCreate,
      pool: template.pool,
      storage: template.storage,
      tags
    }, "Proxmox VM creation started");

    const result = await this.proxmox.createVmFromTemplate({
      targetNode: template.hypervisor,
      templateVmId: template.templateVmId,
      name,
      cpuCores: template.cpu,
      memoryMib: template.memoryMib,
      diskSize: template.diskSize,
      diskDevice: template.diskDevice,
      pool: template.pool,
      storage: template.storage,
      linkedClone: template.linkedClone,
      startOnCreate: template.startOnCreate,
      tags
    });

    this.logger.info({
      event: "proxmox.vm.create.succeeded",
      policyName: policy.name,
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
