import type { ResolvedScalingPolicy } from "@pve-vm-autoscaler/shared";
import type { AutoscalerRepository } from "../db/repository.js";
import { evaluateScalingDecision } from "./decision.js";
import type { ScaleProvisioner, StructuredLogger } from "./types.js";

export interface ScalingEvaluatorOptions {
  repository: AutoscalerRepository;
  policies: ResolvedScalingPolicy[];
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
      policies: this.options.policies.map((policy) => policy.name)
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

  private async evaluatePolicy(policy: ResolvedScalingPolicy): Promise<void> {
    const startedAt = Date.now();
    const labels = policy.selector;
    const [averages, knownNodes, lastEvent] = await Promise.all([
      this.options.repository.getWindowAverages(labels, policy.window),
      // Окно свежести совпадает с окном усреднения: нода, выпавшая из среднего,
      // не должна продолжать занимать место в лимите maxNodes.
      this.options.repository.countKnownNodes(labels, policy.window),
      this.options.repository.getLastScalingEvent(policy.name, policy.scaleUp.cooldown)
    ]);

    const decision = evaluateScalingDecision(policy, averages, knownNodes, Boolean(lastEvent));
    const decisionLog = {
      event: "scaling.decision",
      policyName: policy.name,
      shouldScale: decision.shouldScale,
      reason: decision.reason,
      knownNodes,
      observedNodes: decision.observedNodes,
      averages: decision.averages,
      thresholds: policy.scaleUp,
      windowSeconds: policy.window,
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
      policyName: policy.name,
      reason: decision.reason,
      status: "pending"
    }, "scaling event created");

    try {
      await this.options.repository.updateScalingEvent(event.id, "running");
      this.options.logger.info({
        event: "scaling.event.running",
        scalingEventId: event.id,
        policyName: policy.name
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
        policyName: policy.name,
        status,
        vmId: provisioned.vmId,
        proxmoxTaskId: provisioned.taskId
      }, "scaling event completed");
    } catch (error) {
      await this.options.repository.updateScalingEvent(event.id, "failed");
      this.options.logger.error({
        event: "scaling.event.failed",
        scalingEventId: event.id,
        policyName: policy.name,
        error
      }, "scaling event failed");
    }
  }
}
