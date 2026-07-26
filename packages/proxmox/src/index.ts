import { Agent, request as undiciRequest, type Dispatcher } from "undici";

export interface ProxmoxLogger {
  debug(data: Record<string, unknown>, message?: string): void;
  info(data: Record<string, unknown>, message?: string): void;
  warn(data: Record<string, unknown>, message?: string): void;
  error(data: Record<string, unknown>, message?: string): void;
}

export interface ProxmoxClientOptions {
  baseUrl: string;
  tokenId: string;
  tokenSecret: string;
  dryRun?: boolean;
  tlsRejectUnauthorized?: boolean;
  taskPollIntervalMs?: number;
  taskTimeoutMs?: number;
  logger?: ProxmoxLogger;
}

export interface CreateVmRequest {
  /** Нода Proxmox, на которой создаётся VM. */
  targetNode: string;
  templateVmId: number;
  name: string;
  cpuCores: number;
  /** Объём памяти в мебибайтах — в этих единицах его принимает Proxmox API. */
  memoryMib: number;
  /** Размер диска строкой вида `20G`; если не задан, resize не выполняется. */
  diskSize?: string;
  /** Имя диска для resize: virtio0, scsi0, sata0 — зависит от шаблона. */
  diskDevice: string;
  pool?: string;
  storage?: string;
  linkedClone: boolean;
  tags: string[];
  startOnCreate: boolean;
}

export interface CreateVmResult {
  vmId?: number;
  cloneTaskId?: string;
  startTaskId?: string;
  dryRun: boolean;
}

interface ProxmoxEnvelope<T> {
  data: T;
}

interface ProxmoxRequestInit {
  method: "GET" | "POST" | "PUT";
  body?: URLSearchParams;
}

export class ProxmoxClient {
  private readonly baseUrl: string;
  private readonly taskPollIntervalMs: number;
  private readonly taskTimeoutMs: number;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(private readonly options: ProxmoxClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.taskPollIntervalMs = options.taskPollIntervalMs ?? 2_000;
    this.taskTimeoutMs = options.taskTimeoutMs ?? 120_000;
    this.dispatcher = options.tlsRejectUnauthorized === false
      ? new Agent({ connect: { rejectUnauthorized: false } })
      : undefined;
  }

  async createVmFromTemplate(request: CreateVmRequest): Promise<CreateVmResult> {
    if (this.options.dryRun) {
      this.options.logger?.info({
        event: "proxmox.vm.create.dry_run",
        targetNode: request.targetNode,
        templateVmId: request.templateVmId,
        vmName: request.name
      }, "Proxmox dry-run VM creation skipped");
      return { dryRun: true };
    }

    this.assertConfigured();

    const startedAt = Date.now();
    this.options.logger?.debug({
      event: "proxmox.vm.nextid.requested"
    }, "requesting next Proxmox VMID");
    const vmId = await this.getNextVmId();
    this.options.logger?.info({
      event: "proxmox.vm.nextid.received",
      vmId
    }, "received next Proxmox VMID");

    const cloneTaskId = await this.cloneTemplate(vmId, request);
    this.options.logger?.info({
      event: "proxmox.vm.clone.started",
      vmId,
      cloneTaskId,
      targetNode: request.targetNode,
      templateVmId: request.templateVmId,
      vmName: request.name
    }, "Proxmox clone task started");
    await this.waitForTask(request.targetNode, cloneTaskId);
    this.options.logger?.info({
      event: "proxmox.vm.clone.completed",
      vmId,
      cloneTaskId,
      targetNode: request.targetNode
    }, "Proxmox clone task completed");

    await this.configureVm(vmId, request);
    this.options.logger?.info({
      event: "proxmox.vm.configured",
      vmId,
      targetNode: request.targetNode,
      cpuCores: request.cpuCores,
      memoryMib: request.memoryMib,
      tags: request.tags
    }, "Proxmox VM configured");

    let startTaskId: string | undefined;
    if (request.diskSize) {
      await this.resizeDisk(vmId, request);
      this.options.logger?.info({
        event: "proxmox.vm.disk_resized",
        vmId,
        targetNode: request.targetNode,
        diskDevice: request.diskDevice,
        diskSize: request.diskSize
      }, "Proxmox VM disk resized");
    }

    if (request.startOnCreate) {
      startTaskId = await this.startVm(vmId, request.targetNode);
      this.options.logger?.info({
        event: "proxmox.vm.start.started",
        vmId,
        startTaskId,
        targetNode: request.targetNode
      }, "Proxmox VM start task started");
      await this.waitForTask(request.targetNode, startTaskId);
      this.options.logger?.info({
        event: "proxmox.vm.start.completed",
        vmId,
        startTaskId,
        targetNode: request.targetNode
      }, "Proxmox VM start task completed");
    }

    this.options.logger?.info({
      event: "proxmox.vm.create.completed",
      vmId,
      cloneTaskId,
      startTaskId,
      targetNode: request.targetNode,
      durationMs: Date.now() - startedAt
    }, "Proxmox VM creation completed");

    return {
      vmId,
      cloneTaskId,
      startTaskId,
      dryRun: false
    };
  }

  async getNextVmId(): Promise<number> {
    const response = await this.request<string>("/cluster/nextid", {
      method: "GET"
    });
    return Number(response);
  }

  async waitForTask(node: string, taskId: string): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < this.taskTimeoutMs) {
      const status = await this.request<{ status: string; exitstatus?: string }>(
        `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(taskId)}/status`,
        { method: "GET" }
      );

      if (status.status === "stopped") {
        if (status.exitstatus && status.exitstatus !== "OK") {
          this.options.logger?.error({
            event: "proxmox.task.failed",
            node,
            taskId,
            exitStatus: status.exitstatus,
            durationMs: Date.now() - startedAt
          }, "Proxmox task failed");
          throw new Error(`Proxmox task ${taskId} failed with ${status.exitstatus}`);
        }
        this.options.logger?.debug({
          event: "proxmox.task.completed",
          node,
          taskId,
          durationMs: Date.now() - startedAt
        }, "Proxmox task completed");
        return;
      }

      this.options.logger?.debug({
        event: "proxmox.task.poll",
        node,
        taskId,
        status: status.status,
        elapsedMs: Date.now() - startedAt
      }, "Proxmox task still running");
      await new Promise((resolve) => setTimeout(resolve, this.taskPollIntervalMs));
    }

    this.options.logger?.error({
      event: "proxmox.task.timeout",
      node,
      taskId,
      timeoutMs: this.taskTimeoutMs
    }, "Proxmox task timed out");
    throw new Error(`Timed out waiting for Proxmox task ${taskId}`);
  }

  private async cloneTemplate(vmId: number, request: CreateVmRequest): Promise<string> {
    const body = new URLSearchParams({
      newid: String(vmId),
      name: request.name,
      full: request.linkedClone ? "0" : "1"
    });

    if (request.pool) {
      body.set("pool", request.pool);
    }
    if (request.storage) {
      body.set("storage", request.storage);
    }

    return this.request<string>(
      `/nodes/${encodeURIComponent(request.targetNode)}/qemu/${request.templateVmId}/clone`,
      { method: "POST", body }
    );
  }

  private async configureVm(vmId: number, request: CreateVmRequest): Promise<void> {
    const body = new URLSearchParams({
      cores: String(request.cpuCores),
      // Параметр memory Proxmox принимает в мебибайтах.
      memory: String(request.memoryMib),
      tags: request.tags.join(";")
    });

    await this.request<unknown>(
      `/nodes/${encodeURIComponent(request.targetNode)}/qemu/${vmId}/config`,
      { method: "POST", body }
    );
  }

  private async resizeDisk(vmId: number, request: CreateVmRequest): Promise<void> {
    const body = new URLSearchParams({
      // Имя диска приходит из шаблона машины: virtio0 подходит не всем образам.
      disk: request.diskDevice,
      size: request.diskSize ?? ""
    });

    await this.request<unknown>(
      `/nodes/${encodeURIComponent(request.targetNode)}/qemu/${vmId}/resize`,
      { method: "PUT", body }
    );
  }

  private async startVm(vmId: number, node: string): Promise<string> {
    return this.request<string>(
      `/nodes/${encodeURIComponent(node)}/qemu/${vmId}/status/start`,
      { method: "POST", body: new URLSearchParams() }
    );
  }

  private async request<T>(path: string, init: ProxmoxRequestInit): Promise<T> {
    const response = await undiciRequest(`${this.baseUrl}/api2/json${path}`, {
      method: init.method,
      body: init.body?.toString(),
      headers: {
        "authorization": `PVEAPIToken=${this.options.tokenId}=${this.options.tokenSecret}`,
        ...(init.body ? { "content-type": "application/x-www-form-urlencoded" } : {})
      },
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {})
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const text = await response.body.text();
      throw new Error(`Proxmox API request failed: ${response.statusCode} ${text}`);
    }

    const envelope = (await response.body.json()) as ProxmoxEnvelope<T>;
    return envelope.data;
  }

  private assertConfigured(): void {
    if (!this.baseUrl || !this.options.tokenId || !this.options.tokenSecret) {
      throw new Error("Proxmox client requires baseUrl, tokenId and tokenSecret when dryRun is disabled");
    }
  }
}
