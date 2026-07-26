import { readFileSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import { parsePolicyDocument } from "../config/policyLoader.js";

/**
 * CLI для работы с файлом политик.
 *
 * `validate` проверяет файл, не поднимая сервер и не требуя базы: ошибку конфигурации
 * лучше увидеть до деплоя, а не в логах упавшего контейнера.
 *
 * `convert` переводит политику старого формата (плоский JSON до версии 1) в новый YAML.
 * Конвертер одноразовый и намеренно простой — он не обязан покрывать экзотику,
 * достаточно довести файл до состояния, которое пройдёт `validate`.
 */

/** Поля старого формата, которые умеет переносить конвертер. */
interface LegacyPolicy {
  id?: string;
  enabled?: boolean;
  evaluationWindowSeconds?: number;
  cooldownSeconds?: number;
  minNodes?: number;
  maxNodes?: number;
  thresholds?: { cpuPercent?: number; memoryPercent?: number; diskPercent?: number };
  selector?: { labels?: Record<string, string> };
  proxmox?: {
    targetNode?: string;
    templateVmId?: number;
    vmNamePrefix?: string;
    cpuCores?: number;
    memoryMb?: number;
    diskGb?: number;
    pool?: string;
    storage?: string;
    linkedClone?: boolean;
    startOnCreate?: boolean;
    tags?: string[];
  };
}

/**
 * Переводит политику старого формата в структуру нового файла.
 *
 * @param legacy Разобранный JSON старого формата.
 * @returns Объект, пригодный для сериализации в YAML версии 1.
 * @throws Если отсутствуют поля, без которых новый формат невалиден.
 */
export function convertLegacyPolicy(legacy: LegacyPolicy): unknown {
  const name = legacy.id ?? "converted";
  const proxmox = legacy.proxmox ?? {};

  if (proxmox.targetNode === undefined || proxmox.templateVmId === undefined) {
    throw new Error(
      "в исходном файле нет proxmox.targetNode или proxmox.templateVmId — " +
        "без них шаблон машины собрать нельзя, заполните их вручную"
    );
  }

  const templateName = `${name}-template`;
  const thresholds = legacy.thresholds ?? {};

  const scaleUp: Record<string, string> = {};
  if (thresholds.cpuPercent !== undefined) scaleUp.cpu = `${thresholds.cpuPercent}%`;
  if (thresholds.memoryPercent !== undefined) scaleUp.memory = `${thresholds.memoryPercent}%`;
  if (thresholds.diskPercent !== undefined) scaleUp.disk = `${thresholds.diskPercent}%`;
  if (Object.keys(scaleUp).length === 0) {
    throw new Error("в исходном файле нет ни одного порога в thresholds");
  }
  scaleUp.cooldown = `${legacy.cooldownSeconds ?? 300}s`;

  const template: Record<string, unknown> = {
    hypervisor: proxmox.targetNode,
    templateVmId: proxmox.templateVmId,
    namePrefix: proxmox.vmNamePrefix ?? "autoscaled",
    cpu: proxmox.cpuCores ?? 2,
    // Старый memoryMb — это мебибайты, поэтому переводим в Mi, а не в MB.
    memory: `${proxmox.memoryMb ?? 2048}Mi`,
    diskDevice: "virtio0",
    linkedClone: proxmox.linkedClone ?? true,
    startOnCreate: proxmox.startOnCreate ?? true,
    tags: proxmox.tags ?? ["pve-vm-autoscaler"]
  };

  if (proxmox.diskGb !== undefined) template.disk = `${proxmox.diskGb}Gi`;
  if (proxmox.pool !== undefined) template.pool = proxmox.pool;
  if (proxmox.storage !== undefined) template.storage = proxmox.storage;

  return {
    version: 1,
    nodeTemplates: { [templateName]: template },
    policies: [
      {
        name,
        enabled: legacy.enabled ?? true,
        template: templateName,
        selector: legacy.selector?.labels ?? {},
        nodes: { min: legacy.minNodes ?? 1, max: legacy.maxNodes ?? 10 },
        window: `${legacy.evaluationWindowSeconds ?? 120}s`,
        scaleUp
      }
    ]
  };
}

function usage(): never {
  process.stderr.write(
    "Использование:\n" +
      "  policy validate <файл.yaml>   — проверить файл политик\n" +
      "  policy convert <файл.json>    — сконвертировать старый формат, вывод в stdout\n"
  );
  process.exit(2);
}

function main(argv: string[]): void {
  const [command, file] = argv;

  if (command === undefined || file === undefined) {
    usage();
  }

  if (command === "validate") {
    const policies = parsePolicyDocument(readFileSync(file, "utf8"), file);
    process.stdout.write(`${file}: политик — ${policies.length}\n`);
    for (const policy of policies) {
      process.stdout.write(
        `  ${policy.name}: шаблон ${policy.template.name}, ` +
          `узлы ${policy.nodes.min}..${policy.nodes.max}, окно ${policy.window}s\n`
      );
    }
    return;
  }

  if (command === "convert") {
    const legacy = JSON.parse(readFileSync(file, "utf8")) as LegacyPolicy | LegacyPolicy[];
    if (Array.isArray(legacy)) {
      throw new Error(
        "конвертер обрабатывает один файл политики за раз; " +
          "разложите массив по отдельным файлам и объедините результат вручную"
      );
    }
    const converted = convertLegacyPolicy(legacy);
    // Результат проверяем сразу: молча выдать невалидный файл хуже, чем упасть.
    parsePolicyDocument(stringifyYaml(converted), `${file} (после конвертации)`);
    process.stdout.write(stringifyYaml(converted));
    return;
  }

  usage();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
