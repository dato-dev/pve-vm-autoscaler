import { type ScalingDecision, type ScalingPolicy } from "@pve-vm-autoscaler/shared";
import type { WindowAverages } from "../db/repository.js";

export function evaluateScalingDecision(
  policy: ScalingPolicy,
  averages: WindowAverages,
  knownNodes: number,
  cooldownActive: boolean,
  evaluatedAt = new Date()
): ScalingDecision {
  const observed = {
    cpuPercent: averages.cpuPercent,
    memoryPercent: averages.memoryPercent,
    diskPercent: averages.diskPercent
  };

  if (!policy.enabled) {
    return {
      policyId: policy.id,
      shouldScale: false,
      reason: "policy is disabled",
      observedNodes: averages.observedNodes,
      averages: observed,
      evaluatedAt: evaluatedAt.toISOString()
    };
  }

  if (cooldownActive) {
    return {
      policyId: policy.id,
      shouldScale: false,
      reason: "cooldown is active",
      observedNodes: averages.observedNodes,
      averages: observed,
      evaluatedAt: evaluatedAt.toISOString()
    };
  }

  if (knownNodes >= policy.maxNodes) {
    return {
      policyId: policy.id,
      shouldScale: false,
      reason: `max nodes reached (${knownNodes}/${policy.maxNodes})`,
      observedNodes: averages.observedNodes,
      averages: observed,
      evaluatedAt: evaluatedAt.toISOString()
    };
  }

  if (knownNodes < policy.minNodes) {
    return {
      policyId: policy.id,
      shouldScale: true,
      reason: `known nodes below minNodes (${knownNodes}/${policy.minNodes})`,
      observedNodes: averages.observedNodes,
      averages: observed,
      evaluatedAt: evaluatedAt.toISOString()
    };
  }

  if (averages.observedNodes === 0) {
    return {
      policyId: policy.id,
      shouldScale: false,
      reason: "no metrics observed in evaluation window",
      observedNodes: averages.observedNodes,
      averages: observed,
      evaluatedAt: evaluatedAt.toISOString()
    };
  }

  if (averages.cpuPercent !== null && averages.cpuPercent >= policy.thresholds.cpuPercent) {
    return {
      policyId: policy.id,
      shouldScale: true,
      reason: `cpu average ${averages.cpuPercent.toFixed(1)} >= ${policy.thresholds.cpuPercent}`,
      observedNodes: averages.observedNodes,
      averages: observed,
      evaluatedAt: evaluatedAt.toISOString()
    };
  }

  if (averages.memoryPercent !== null && averages.memoryPercent >= policy.thresholds.memoryPercent) {
    return {
      policyId: policy.id,
      shouldScale: true,
      reason: `memory average ${averages.memoryPercent.toFixed(1)} >= ${policy.thresholds.memoryPercent}`,
      observedNodes: averages.observedNodes,
      averages: observed,
      evaluatedAt: evaluatedAt.toISOString()
    };
  }

  if (
    policy.thresholds.diskPercent !== undefined &&
    averages.diskPercent !== null &&
    averages.diskPercent >= policy.thresholds.diskPercent
  ) {
    return {
      policyId: policy.id,
      shouldScale: true,
      reason: `disk average ${averages.diskPercent.toFixed(1)} >= ${policy.thresholds.diskPercent}`,
      observedNodes: averages.observedNodes,
      averages: observed,
      evaluatedAt: evaluatedAt.toISOString()
    };
  }

  return {
    policyId: policy.id,
    shouldScale: false,
    reason: "thresholds are healthy",
    observedNodes: averages.observedNodes,
    averages: observed,
    evaluatedAt: evaluatedAt.toISOString()
  };
}
