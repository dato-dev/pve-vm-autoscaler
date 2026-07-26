import { describe, expect, it } from "vitest";
import { scalingPolicySchema } from "@pve-vm-autoscaler/shared";
import { evaluateScalingDecision } from "./decision.js";

const policy = scalingPolicySchema.parse({
  id: "default",
  thresholds: {
    cpuPercent: 80,
    memoryPercent: 80
  },
  selector: {
    labels: {
      role: "worker"
    }
  },
  proxmox: {
    targetNode: "pve-1",
    templateVmId: 9000
  }
});

describe("evaluateScalingDecision", () => {
  it("scales when cpu average crosses the threshold", () => {
    const decision = evaluateScalingDecision(
      policy,
      {
        observedNodes: 2,
        cpuPercent: 85,
        memoryPercent: 40,
        diskPercent: 30
      },
      2,
      false,
      new Date("2026-05-10T09:00:00.000Z")
    );

    expect(decision.shouldScale).toBe(true);
    expect(decision.reason).toContain("cpu average");
  });

  it("does not scale during cooldown", () => {
    const decision = evaluateScalingDecision(
      policy,
      {
        observedNodes: 2,
        cpuPercent: 95,
        memoryPercent: 95,
        diskPercent: 30
      },
      2,
      true
    );

    expect(decision.shouldScale).toBe(false);
    expect(decision.reason).toBe("cooldown is active");
  });

  it("respects maxNodes", () => {
    const decision = evaluateScalingDecision(
      policy,
      {
        observedNodes: 10,
        cpuPercent: 95,
        memoryPercent: 95,
        diskPercent: 30
      },
      10,
      false
    );

    expect(decision.shouldScale).toBe(false);
    expect(decision.reason).toContain("max nodes reached");
  });
});
