import type { ScalingPolicy } from "@pve-vm-autoscaler/shared";
import type { AutoscalerRepository } from "../db/repository.js";
import { evaluateScalingDecision } from "./decision.js";
import type { ScaleProvisioner, StructuredLogger } from "./types.js";

export interface ScalingEvaluatorOptions {
  repository: AutoscalerRepository;
  policies: ScalingPolicy[];
  provisioner: ScaleProvisioner;
  intervalMs: number;
  logger: StructuredLogger;
}

export class ScalingEvaluator {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: ScalingEvaluatorOptions) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.options.logger.info({
      event: "scaling.evaluator.started",
      intervalMs: this.options.intervalMs,
      policyCount: this.options.policies.length,
      policies: this.options.policies.map((policy) => policy.id)
    }, "scaling evaluator started");

    this.timer = setInterval(() => {
      void this.evaluateOnce();
    }, this.options.intervalMs);
    void this.evaluateOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    this.options.logger.info({
      event: "scaling.evaluator.stopped"
    }, "scaling evaluator stopped");
  }

  async evaluateOnce(): Promise<void> {
    if (this.running) {
      this.options.logger.debug({
        event: "scaling.evaluation.skipped",
        reason: "previous evaluation is still running"
      }, "scaling evaluation skipped");
      return;
    }

    this.running = true;
    const startedAt = Date.now();
    try {
      for (const policy of this.options.policies) {
        await this.evaluatePolicy(policy);
      }
      this.options.logger.debug({
        event: "scaling.evaluation.completed",
        durationMs: Date.now() - startedAt
      }, "scaling evaluation completed");
    } finally {
      this.running = false;
    }
  }

  private async evaluatePolicy(policy: ScalingPolicy): Promise<void> {
    const startedAt = Date.now();
    const labels = policy.selector.labels;
    const [averages, knownNodes, lastEvent] = await Promise.all([
      this.options.repository.getWindowAverages(labels, policy.evaluationWindowSeconds),
      // Окно свежести совпадает с окном усреднения: нода, выпавшая из среднего,
      // не должна продолжать занимать место в лимите maxNodes.
      this.options.repository.countKnownNodes(labels, policy.evaluationWindowSeconds),
      this.options.repository.getLastScalingEvent(policy.id, policy.cooldownSeconds)
    ]);

    const decision = evaluateScalingDecision(policy, averages, knownNodes, Boolean(lastEvent));
    const decisionLog = {
      event: "scaling.decision",
      policyId: policy.id,
      shouldScale: decision.shouldScale,
      reason: decision.reason,
      knownNodes,
      observedNodes: decision.observedNodes,
      averages: decision.averages,
      thresholds: policy.thresholds,
      evaluationWindowSeconds: policy.evaluationWindowSeconds,
      cooldownActive: Boolean(lastEvent),
      durationMs: Date.now() - startedAt
    };

    if (!decision.shouldScale) {
      this.options.logger.debug(decisionLog, "scaling decision did not request scale-up");
      return;
    }

    this.options.logger.info(decisionLog, "scaling decision requested scale-up");
    const event = await this.options.repository.createScalingEvent(decision, "pending");
    this.options.logger.info({
      event: "scaling.event.created",
      scalingEventId: event.id,
      policyId: policy.id,
      reason: decision.reason,
      status: "pending"
    }, "scaling event created");

    try {
      await this.options.repository.updateScalingEvent(event.id, "running");
      this.options.logger.info({
        event: "scaling.event.running",
        scalingEventId: event.id,
        policyId: policy.id
      }, "scaling event running");

      const provisioned = await this.options.provisioner.createNode(policy, decision.reason);
      const status = provisioned.dryRun ? "dry_run" : "succeeded";
      await this.options.repository.updateScalingEvent(
        event.id,
        status,
        provisioned.taskId,
        provisioned.vmId
      );
      this.options.logger.info({
        event: "scaling.event.completed",
        scalingEventId: event.id,
        policyId: policy.id,
        status,
        vmId: provisioned.vmId,
        proxmoxTaskId: provisioned.taskId
      }, "scaling event completed");
    } catch (error) {
      await this.options.repository.updateScalingEvent(event.id, "failed");
      this.options.logger.error({
        event: "scaling.event.failed",
        scalingEventId: event.id,
        policyId: policy.id,
        error
      }, "scaling event failed");
    }
  }
}
