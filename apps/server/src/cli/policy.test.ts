import { describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { convertLegacyPolicy } from "./policy.js";
import { parsePolicyDocument } from "../config/policyLoader.js";

/** Политика ровно в том виде, в каком она лежала в infra/policy.example.json до M2. */
function legacyPolicy(): Record<string, unknown> {
  return {
    id: "default-workers",
    enabled: true,
    sampleIntervalSeconds: 5,
    evaluationWindowSeconds: 120,
    cooldownSeconds: 300,
    minNodes: 1,
    maxNodes: 5,
    thresholds: { cpuPercent: 60, memoryPercent: 80, diskPercent: 90 },
    selector: { labels: { role: "worker" } },
    proxmox: {
      targetNode: "proxmox",
      templateVmId: 100,
      vmNamePrefix: "autoscaled-worker",
      cpuCores: 2,
      memoryMb: 2048,
      diskGb: 20,
      linkedClone: true,
      startOnCreate: false,
      tags: ["pve-vm-autoscaler", "worker"]
    }
  };
}

describe("convertLegacyPolicy", () => {
  it("выдаёт файл, который проходит валидацию нового формата", () => {
    const yaml = stringifyYaml(convertLegacyPolicy(legacyPolicy()));
    const [policy] = parsePolicyDocument(yaml, "converted.yaml");

    expect(policy?.name).toBe("default-workers");
    expect(policy?.nodes).toEqual({ min: 1, max: 5 });
    expect(policy?.window).toBe(120);
    expect(policy?.scaleUp.cooldown).toBe(300);
    expect(policy?.selector).toEqual({ role: "worker" });
  });

  it("переносит величины без потери смысла", () => {
    const yaml = stringifyYaml(convertLegacyPolicy(legacyPolicy()));
    const [policy] = parsePolicyDocument(yaml, "converted.yaml");

    // memoryMb старого формата — это мебибайты, поэтому 2048 обязано остаться 2048,
    // а не превратиться в мегабайты и потерять 4% объёма.
    expect(policy?.template.memoryMib).toBe(2048);
    expect(policy?.template.diskSize).toBe("20G");
    expect(policy?.scaleUp.cpu).toBe(60);
    expect(policy?.scaleUp.memory).toBe(80);
    expect(policy?.scaleUp.disk).toBe(90);
  });

  it("сохраняет флаги шаблона, а не подставляет умолчания", () => {
    const yaml = stringifyYaml(convertLegacyPolicy(legacyPolicy()));
    const [policy] = parsePolicyDocument(yaml, "converted.yaml");

    // startOnCreate был false — если конвертер подставит умолчание true,
    // поведение после миграции молча изменится.
    expect(policy?.template.startOnCreate).toBe(false);
    expect(policy?.template.namePrefix).toBe("autoscaled-worker");
    expect(policy?.template.tags).toEqual(["pve-vm-autoscaler", "worker"]);
  });

  it("не переносит мёртвое поле sampleIntervalSeconds", () => {
    const converted = JSON.stringify(convertLegacyPolicy(legacyPolicy()));

    expect(converted).not.toContain("sampleIntervalSeconds");
  });

  it("падает, если в исходнике нет данных для шаблона машины", () => {
    const withoutProxmox = { ...legacyPolicy(), proxmox: {} };

    expect(() => convertLegacyPolicy(withoutProxmox)).toThrow(/targetNode или proxmox.templateVmId/);
  });

  it("падает, если в исходнике нет ни одного порога", () => {
    const withoutThresholds = { ...legacyPolicy(), thresholds: {} };

    expect(() => convertLegacyPolicy(withoutThresholds)).toThrow(/ни одного порога/);
  });

  it("подставляет умолчания там, где старый файл был неполным", () => {
    const minimal = {
      id: "minimal",
      thresholds: { cpuPercent: 75 },
      proxmox: { targetNode: "pve-1", templateVmId: 200 }
    };

    const yaml = stringifyYaml(convertLegacyPolicy(minimal));
    const [policy] = parsePolicyDocument(yaml, "converted.yaml");

    expect(policy?.nodes).toEqual({ min: 1, max: 10 });
    expect(policy?.window).toBe(120);
    expect(policy?.template.memoryMib).toBe(2048);
    expect(policy?.template.diskSize).toBeUndefined();
  });
});
