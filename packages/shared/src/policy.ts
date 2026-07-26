import { z } from "zod";
import { bytesToMib, bytesToProxmoxDiskSize, parseDuration, parsePercent, parseQuantity } from "./units.js";

/**
 * Схема файла политик.
 *
 * Файл разделён на две части по частоте изменения. `nodeTemplates` описывает, **что**
 * создавать — свойства машины, которые правят раз в полгода. `policies` описывает,
 * **когда** масштабировать — пороги и окна, которые тюнят постоянно. Политика ссылается
 * на шаблон по имени, поэтому несколько пулов с одинаковыми машинами не дублируют блок
 * настроек Proxmox.
 */

const nodeLabelsSchema = z.record(z.string(), z.string());

/**
 * Оборачивает парсер единиц измерения в Zod-схему.
 *
 * Сообщение парсера попадает в issue как есть, поэтому пользователь видит текст вида
 * «не удалось разобрать длительность «5x»…» вместе с путём до поля, а не абстрактное
 * «Invalid input».
 */
function parsedWith<T>(parse: (input: string | number) => T) {
  return z.union([z.string(), z.number()]).transform((value, ctx) => {
    try {
      return parse(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error)
      });
      return z.NEVER;
    }
  });
}

export const nodeTemplateSchema = z.object({
  /** Нода Proxmox, на которой создаётся VM. Не путать с воркер-VM, которые масштабируются. */
  hypervisor: z.string().min(1),
  templateVmId: z.number().int().positive(),
  namePrefix: z.string().min(1).default("autoscaled"),
  /** Количество ядер. Именно ядра, а не проценты — пороги записываются со знаком «%». */
  cpu: z.number().int().positive().default(2),
  memory: parsedWith(parseQuantity),
  disk: parsedWith(parseQuantity).optional(),
  /** Имя диска для resize. Раньше было захардкожено как virtio0 и ломалось на scsi0-шаблонах. */
  diskDevice: z.string().min(1).default("virtio0"),
  pool: z.string().optional(),
  storage: z.string().optional(),
  linkedClone: z.boolean().default(true),
  startOnCreate: z.boolean().default(true),
  tags: z.array(z.string()).default(["pve-vm-autoscaler"])
});

const thresholdsSchema = z
  .object({
    cpu: parsedWith(parsePercent).optional(),
    memory: parsedWith(parsePercent).optional(),
    disk: parsedWith(parsePercent).optional(),
    cooldown: parsedWith(parseDuration).default("5m")
  })
  .refine(
    (thresholds) =>
      thresholds.cpu !== undefined ||
      thresholds.memory !== undefined ||
      thresholds.disk !== undefined,
    { message: "нужен хотя бы один порог: cpu, memory или disk" }
  );

export const policyEntrySchema = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    /** Имя шаблона из nodeTemplates. */
    template: z.string().min(1),
    /** Метки агентов, попадающих под политику. Пустой объект совпадает со всеми. */
    selector: nodeLabelsSchema.default({}),
    nodes: z
      .object({
        min: z.number().int().nonnegative().default(1),
        max: z.number().int().positive().default(10)
      })
      .default({}),
    /** Окно усреднения нагрузки. Должно быть заметно больше интервала отправки метрик. */
    window: parsedWith(parseDuration).default("2m"),
    scaleUp: thresholdsSchema,
    /** Появится в Milestone 4. Схема заведена заранее, чтобы формат не менялся дважды. */
    scaleDown: thresholdsSchema.optional()
  })
  .refine((policy) => policy.nodes.min <= policy.nodes.max, {
    message: "nodes.min не может превышать nodes.max",
    path: ["nodes", "min"]
  });

export const policyFileSchema = z.object({
  /** Версия формата. Точка расширения: следующая смена структуры станет миграцией, а не поломкой. */
  version: z.literal(1),
  nodeTemplates: z.record(z.string(), nodeTemplateSchema),
  policies: z.array(policyEntrySchema).min(1, "нужна хотя бы одна политика")
});

// NodeLabels намеренно не реэкспортируется: тип с этим именем уже есть в index.ts,
// и `export *` дал бы конфликт имён.
export type NodeTemplate = z.infer<typeof nodeTemplateSchema>;
export type PolicyEntry = z.infer<typeof policyEntrySchema>;
export type PolicyFile = z.infer<typeof policyFileSchema>;

/** Шаблон машины с величинами, переведёнными в единицы Proxmox. */
export interface ResolvedNodeTemplate extends Omit<NodeTemplate, "memory" | "disk"> {
  /** Имя шаблона из ключа nodeTemplates — попадает в логи. */
  name: string;
  /** Proxmox принимает объём памяти в мебибайтах. */
  memoryMib: number;
  /** Строка для resize вида `20G`; отсутствует, если размер диска не задан. */
  diskSize?: string;
}

/** Политика с подставленным шаблоном: evaluator не занимается разрешением ссылок. */
export interface ResolvedScalingPolicy extends Omit<PolicyEntry, "template"> {
  template: ResolvedNodeTemplate;
}

/**
 * Превращает ошибки валидации в строки, пригодные для показа оператору.
 *
 * Zod по умолчанию отдаёт дерево issue без указания места в файле. Оператору нужен
 * путь до поля и текст, объясняющий, как записать значение верно.
 *
 * @param error Ошибка разбора файла политик.
 * @returns Строки вида `policies.0.scaleUp.cpu: процент записывается со знаком «%»…`.
 */
export function formatPolicyIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path === "" ? issue.message : `${path}: ${issue.message}`;
  });
}

/**
 * Подставляет шаблоны в политики и переводит величины в единицы Proxmox.
 *
 * @param file Разобранный и провалидированный файл политик.
 * @returns Самодостаточные политики — evaluator не знает про `nodeTemplates`.
 * @throws Если политика ссылается на несуществующий шаблон. Сообщение перечисляет
 *   доступные имена: опечатка в ссылке иначе выглядит как «шаблон не найден» без подсказки.
 */
export function resolvePolicyFile(file: PolicyFile): ResolvedScalingPolicy[] {
  const templateNames = Object.keys(file.nodeTemplates);

  return file.policies.map((policy) => {
    const template = file.nodeTemplates[policy.template];

    if (!template) {
      throw new Error(
        `политика «${policy.name}» ссылается на шаблон «${policy.template}», которого нет в nodeTemplates. ` +
          `Доступные шаблоны: ${templateNames.length > 0 ? templateNames.join(", ") : "ни одного"}`
      );
    }

    const { memory, disk, ...machine } = template;

    return {
      name: policy.name,
      enabled: policy.enabled,
      selector: policy.selector,
      nodes: policy.nodes,
      window: policy.window,
      scaleUp: policy.scaleUp,
      scaleDown: policy.scaleDown,
      template: {
        ...machine,
        name: policy.template,
        memoryMib: bytesToMib(memory),
        diskSize: disk === undefined ? undefined : bytesToProxmoxDiskSize(disk)
      }
    };
  });
}
