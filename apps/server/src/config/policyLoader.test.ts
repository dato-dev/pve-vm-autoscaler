import { describe, expect, it } from "vitest";
import { parsePolicyDocument } from "./policyLoader.js";

const VALID = `
version: 1
nodeTemplates:
  worker:
    hypervisor: pve-1
    templateVmId: 100
    memory: 2Gi
    disk: 20Gi
policies:
  - name: default-workers
    template: worker
    selector:
      role: worker
    nodes: { min: 1, max: 5 }
    window: 2m
    scaleUp:
      cpu: 60%
      cooldown: 5m
`;

describe("parsePolicyDocument", () => {
  it("разбирает валидный файл и подставляет шаблон", () => {
    const [policy] = parsePolicyDocument(VALID, "policy.yaml");

    expect(policy?.name).toBe("default-workers");
    expect(policy?.window).toBe(120);
    expect(policy?.scaleUp.cooldown).toBe(300);
    expect(policy?.nodes).toEqual({ min: 1, max: 5 });
    expect(policy?.template.memoryMib).toBe(2048);
    expect(policy?.template.diskSize).toBe("20G");
  });

  it("не превращает no и on в булевы значения", () => {
    // Ради этого выбран парсер YAML 1.2: в 1.1 значения no/off/yes/on стали бы
    // булевыми и сломали произвольные пользовательские метки в selector.
    const withTrickyLabels = VALID.replace(
      "      role: worker",
      "      role: worker\n      env: no\n      ha: on"
    );

    const [policy] = parsePolicyDocument(withTrickyLabels, "policy.yaml");

    expect(policy?.selector).toEqual({ role: "worker", env: "no", ha: "on" });
  });

  it("сообщает имя файла и причину, если YAML синтаксически битый", () => {
    expect(() => parsePolicyDocument("version: 1\n  policies: [", "broken.yaml")).toThrow(
      /broken\.yaml: файл не является корректным YAML/
    );
  });

  it("перечисляет все проблемы схемы разом, с путями до полей", () => {
    const broken = VALID.replace("cpu: 60%", "cpu: 60").replace("memory: 2Gi", "memory: 2GB");

    let message = "";
    try {
      parsePolicyDocument(broken, "policy.yaml");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // Чинить конфигурацию по одной ошибке за прогон — плохой опыт,
    // поэтому загрузчик выводит их списком.
    expect(message).toContain("nodeTemplates.worker.memory");
    expect(message).toContain("policies.0.scaleUp.cpu");
    expect(message).toContain("со знаком «%»");
  });

  it("распознаёт политику старого формата и подсказывает конвертер", () => {
    // YAML 1.2 — надмножество JSON, поэтому старый файл разберётся успешно
    // и упрётся только в схему. Без подсказки это выглядит как набор
    // непонятных ошибок вместо «формат сменился».
    const legacy = JSON.stringify({
      id: "old",
      maxNodes: 5,
      thresholds: { cpuPercent: 60 },
      proxmox: { targetNode: "pve-1", templateVmId: 100 }
    });

    expect(() => parsePolicyDocument(legacy, "policy.json")).toThrow(/старом формате/);
    expect(() => parsePolicyDocument(legacy, "policy.json")).toThrow(/policy:convert/);
  });

  it("не подсказывает конвертер для просто неверного нового файла", () => {
    const notLegacy = "version: 1\nnodeTemplates: {}\npolicies: []\n";

    expect(() => parsePolicyDocument(notLegacy, "policy.yaml")).toThrow(/не прошла проверку/);
    expect(() => parsePolicyDocument(notLegacy, "policy.yaml")).not.toThrow(/старом формате/);
  });

  it("сообщает о ссылке на несуществующий шаблон", () => {
    const broken = VALID.replace("template: worker", "template: wroker");

    expect(() => parsePolicyDocument(broken, "policy.yaml")).toThrow(/«wroker»/);
  });
});
