import { describe, expect, it } from "vitest";
import {
  policyFileSchema,
  resolvePolicyFile,
  type ResolvedScalingPolicy
} from "@pve-vm-autoscaler/shared";
import { evaluateScalingDecision } from "./decision.js";

/** Собирает политику через настоящую схему — тест не расходится с форматом файла. */
function buildPolicy(policyOverrides: Record<string, unknown> = {}): ResolvedScalingPolicy {
  const file = policyFileSchema.parse({
    version: 1,
    nodeTemplates: {
      worker: { hypervisor: "pve-1", templateVmId: 9000, memory: "2Gi" }
    },
    policies: [
      {
        name: "default",
        template: "worker",
        selector: { role: "worker" },
        nodes: { min: 1, max: 10 },
        scaleUp: { cpu: "80%", memory: "80%" },
        ...policyOverrides
      }
    ]
  });

  const [policy] = resolvePolicyFile(file);
  if (!policy) {
    throw new Error("политика не собралась");
  }
  return policy;
}

const AT = new Date("2026-05-10T09:00:00.000Z");

describe("evaluateScalingDecision", () => {
  it("масштабирует, когда средний CPU перешёл порог", () => {
    const decision = evaluateScalingDecision(
      buildPolicy(),
      { observedNodes: 2, cpuPercent: 85, memoryPercent: 40, diskPercent: 30 },
      2,
      false,
      AT
    );

    expect(decision.shouldScale).toBe(true);
    expect(decision.reason).toContain("cpu average");
    expect(decision.policyName).toBe("default");
    expect(decision.evaluatedAt).toBe(AT.toISOString());
  });

  it("не масштабирует во время cooldown, даже при запредельной нагрузке", () => {
    // Порядок проверок значим: cooldown существует именно чтобы не реагировать
    // на нагрузку, поэтому он отсекает решение раньше порогов.
    const decision = evaluateScalingDecision(
      buildPolicy(),
      { observedNodes: 2, cpuPercent: 95, memoryPercent: 95, diskPercent: 30 },
      2,
      true,
      AT
    );

    expect(decision.shouldScale).toBe(false);
    expect(decision.reason).toBe("cooldown is active");
  });

  it("соблюдает nodes.max", () => {
    const decision = evaluateScalingDecision(
      buildPolicy(),
      { observedNodes: 10, cpuPercent: 95, memoryPercent: 95, diskPercent: 30 },
      10,
      false,
      AT
    );

    expect(decision.shouldScale).toBe(false);
    expect(decision.reason).toContain("max nodes reached");
  });

  it("добирает пул до nodes.min, даже если метрик ещё нет", () => {
    // Пустой пул не присылает метрик, поэтому добор обязан работать без них.
    const decision = evaluateScalingDecision(
      buildPolicy({ nodes: { min: 2, max: 10 }, scaleUp: { cpu: "80%" } }),
      { observedNodes: 0, cpuPercent: null, memoryPercent: null, diskPercent: null },
      0,
      false,
      AT
    );

    expect(decision.shouldScale).toBe(true);
    expect(decision.reason).toContain("below nodes.min");
  });

  it("не масштабирует, когда в окне нет ни одной ноды с метриками", () => {
    // null в средних означает «данных нет», а не «нагрузка нулевая»: решать вслепую нельзя.
    const decision = evaluateScalingDecision(
      buildPolicy(),
      { observedNodes: 0, cpuPercent: null, memoryPercent: null, diskPercent: null },
      3,
      false,
      AT
    );

    expect(decision.shouldScale).toBe(false);
    expect(decision.reason).toBe("no metrics observed in evaluation window");
  });

  it("не масштабирует выключенную политику", () => {
    const decision = evaluateScalingDecision(
      buildPolicy({ enabled: false }),
      { observedNodes: 2, cpuPercent: 99, memoryPercent: 99, diskPercent: 99 },
      2,
      false,
      AT
    );

    expect(decision.shouldScale).toBe(false);
    expect(decision.reason).toBe("policy is disabled");
  });

  it("игнорирует порог, который в политике не задан", () => {
    // disk в scaleUp отсутствует, поэтому заполненный диск не должен вызывать рост.
    const decision = evaluateScalingDecision(
      buildPolicy({ scaleUp: { cpu: "80%" } }),
      { observedNodes: 2, cpuPercent: 10, memoryPercent: 99, diskPercent: 99 },
      2,
      false,
      AT
    );

    expect(decision.shouldScale).toBe(false);
    expect(decision.reason).toBe("thresholds are healthy");
  });

  it("срабатывает по памяти, когда CPU в норме", () => {
    const decision = evaluateScalingDecision(
      buildPolicy(),
      { observedNodes: 2, cpuPercent: 10, memoryPercent: 85, diskPercent: 30 },
      2,
      false,
      AT
    );

    expect(decision.shouldScale).toBe(true);
    expect(decision.reason).toContain("memory average");
  });
});
