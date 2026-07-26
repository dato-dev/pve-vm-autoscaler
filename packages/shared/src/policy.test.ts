import { describe, expect, it } from "vitest";
import { policyFileSchema, resolvePolicyFile } from "./policy.js";

/**
 * Собирает файл политик из минимального валидного набора с точечными заменами.
 * Так тесты не мутируют вложенные структуры по индексу и остаются читаемыми.
 */
function fileWith(
  policyOverrides: Record<string, unknown> = {},
  templateOverrides: Record<string, unknown> = {}
): unknown {
  return {
    version: 1,
    nodeTemplates: {
      worker: {
        hypervisor: "pve-1",
        templateVmId: 100,
        memory: "2Gi",
        ...templateOverrides
      }
    },
    policies: [
      {
        name: "default-workers",
        template: "worker",
        scaleUp: { cpu: "60%" },
        ...policyOverrides
      }
    ]
  };
}

/** Путь до поля в первой ошибке — по нему оператор находит место в файле. */
function firstIssuePath(input: unknown): string {
  const result = policyFileSchema.safeParse(input);
  if (result.success) {
    throw new Error("ожидалась ошибка валидации");
  }
  return result.error.issues[0]?.path.join(".") ?? "";
}

/** Текст первой ошибки. */
function firstIssueMessage(input: unknown): string {
  const result = policyFileSchema.safeParse(input);
  if (result.success) {
    throw new Error("ожидалась ошибка валидации");
  }
  return result.error.issues[0]?.message ?? "";
}

describe("policyFileSchema", () => {
  it("принимает минимальный файл и проставляет умолчания", () => {
    const file = policyFileSchema.parse(fileWith());
    const policy = file.policies[0];
    const template = file.nodeTemplates.worker;

    expect(policy?.enabled).toBe(true);
    expect(policy?.nodes).toEqual({ min: 1, max: 10 });
    expect(policy?.window).toBe(120);
    expect(policy?.scaleUp.cooldown).toBe(300);
    expect(policy?.selector).toEqual({});

    expect(template?.namePrefix).toBe("autoscaled");
    expect(template?.cpu).toBe(2);
    expect(template?.diskDevice).toBe("virtio0");
    expect(template?.linkedClone).toBe(true);
    expect(template?.tags).toEqual(["pve-vm-autoscaler"]);
  });

  it("разбирает единицы измерения в значениях", () => {
    const file = policyFileSchema.parse(
      fileWith(
        { window: "5m", scaleUp: { cpu: "60%", memory: "80%", cooldown: "1h30m" } },
        { disk: "20Gi" }
      )
    );

    expect(file.nodeTemplates.worker?.memory).toBe(2 * 1024 ** 3);
    expect(file.nodeTemplates.worker?.disk).toBe(20 * 1024 ** 3);
    expect(file.policies[0]?.window).toBe(300);
    expect(file.policies[0]?.scaleUp.cooldown).toBe(5400);
    expect(file.policies[0]?.scaleUp.cpu).toBe(60);
    expect(file.policies[0]?.scaleUp.memory).toBe(80);
  });

  it("указывает путь до поля с неверной единицей", () => {
    expect(firstIssuePath(fileWith({ scaleUp: { cpu: "60" } }))).toBe("policies.0.scaleUp.cpu");
    expect(firstIssuePath(fileWith({}, { memory: "2GB" }))).toBe("nodeTemplates.worker.memory");
  });

  it("передаёт текст ошибки парсера, а не абстрактное «Invalid input»", () => {
    expect(firstIssueMessage(fileWith({ window: "5x" }))).toMatch(/s, m, h или d/);
    expect(firstIssueMessage(fileWith({ scaleUp: { cpu: "60" } }))).toMatch(/со знаком «%»/);
  });

  it("требует хотя бы один порог в scaleUp", () => {
    expect(firstIssueMessage(fileWith({ scaleUp: {} }))).toMatch(/хотя бы один порог/);
  });

  it("не пропускает nodes.min больше nodes.max", () => {
    const input = fileWith({ nodes: { min: 5, max: 2 } });

    expect(firstIssuePath(input)).toBe("policies.0.nodes.min");
    expect(firstIssueMessage(input)).toMatch(/не может превышать/);
  });

  it("не принимает файл без версии или с чужой версией", () => {
    expect(policyFileSchema.safeParse({ nodeTemplates: {}, policies: [] }).success).toBe(false);

    const wrongVersion = { ...(fileWith() as object), version: 2 };
    expect(policyFileSchema.safeParse(wrongVersion).success).toBe(false);
  });

  it("не принимает файл без политик", () => {
    const empty = { ...(fileWith() as object), policies: [] };
    expect(policyFileSchema.safeParse(empty).success).toBe(false);
  });

  it("не даёт булевым значениям просочиться в метки селектора", () => {
    // В YAML 1.1 значение env: no стало бы false. Парсер 1.2 так не делает,
    // но схема обязана отвергнуть булево, если файл разобран чем-то другим.
    expect(firstIssuePath(fileWith({ selector: { env: false } }))).toBe(
      "policies.0.selector.env"
    );
  });

  it("принимает метки, похожие на булевы, как строки", () => {
    const file = policyFileSchema.parse(fileWith({ selector: { env: "no", ha: "on" } }));

    expect(file.policies[0]?.selector).toEqual({ env: "no", ha: "on" });
  });
});

describe("resolvePolicyFile", () => {
  it("подставляет шаблон в политику", () => {
    const [policy] = resolvePolicyFile(policyFileSchema.parse(fileWith()));

    expect(policy?.template.name).toBe("worker");
    expect(policy?.template.hypervisor).toBe("pve-1");
    expect(policy?.template.templateVmId).toBe(100);
  });

  it("переводит память в мебибайты, а диск — в строку размера Proxmox", () => {
    const [policy] = resolvePolicyFile(
      policyFileSchema.parse(fileWith({}, { disk: "20Gi" }))
    );

    expect(policy?.template.memoryMib).toBe(2048);
    expect(policy?.template.diskSize).toBe("20G");
  });

  it("оставляет diskSize пустым, если размер диска не задан", () => {
    const [policy] = resolvePolicyFile(policyFileSchema.parse(fileWith()));

    expect(policy?.template.diskSize).toBeUndefined();
  });

  it("позволяет нескольким политикам использовать один шаблон", () => {
    const file = policyFileSchema.parse({
      version: 1,
      nodeTemplates: {
        worker: { hypervisor: "pve-1", templateVmId: 100, memory: "2Gi" }
      },
      policies: [
        { name: "day", template: "worker", scaleUp: { cpu: "60%" } },
        { name: "night", template: "worker", scaleUp: { cpu: "90%" } }
      ]
    });

    const resolved = resolvePolicyFile(file);

    expect(resolved).toHaveLength(2);
    expect(resolved[0]?.template.templateVmId).toBe(100);
    expect(resolved[1]?.template.templateVmId).toBe(100);
    expect(resolved[0]?.scaleUp.cpu).toBe(60);
    expect(resolved[1]?.scaleUp.cpu).toBe(90);
  });

  it("сообщает о ссылке на несуществующий шаблон и перечисляет доступные", () => {
    const file = policyFileSchema.parse({
      version: 1,
      nodeTemplates: {
        worker: { hypervisor: "pve-1", templateVmId: 100, memory: "2Gi" },
        gpu: { hypervisor: "pve-2", templateVmId: 200, memory: "8Gi" }
      },
      policies: [{ name: "p", template: "wroker", scaleUp: { cpu: "60%" } }]
    });

    // Опечатка в имени шаблона без перечня доступных выглядит как «не найдено» без подсказки.
    expect(() => resolvePolicyFile(file)).toThrow(/«wroker»/);
    expect(() => resolvePolicyFile(file)).toThrow(/worker, gpu/);
  });
});
