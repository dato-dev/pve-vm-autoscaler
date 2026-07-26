import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  formatPolicyIssues,
  policyFileSchema,
  resolvePolicyFile,
  type ResolvedScalingPolicy
} from "@pve-vm-autoscaler/shared";

/**
 * Разбирает содержимое файла политик.
 *
 * Вынесено из работы с файловой системой, чтобы разбор можно было тестировать на строке,
 * а `validate` и загрузчик сервера использовали один и тот же код.
 *
 * @param content Содержимое YAML-файла.
 * @param source Имя файла для сообщений об ошибках.
 * @returns Самодостаточные политики с подставленными шаблонами.
 * @throws С многострочным сообщением, перечисляющим все проблемы разом: чинить конфигурацию
 *   по одной ошибке за прогон — плохой опыт, особенно при переезде со старого формата.
 */
export function parsePolicyDocument(content: string, source: string): ResolvedScalingPolicy[] {
  let document: unknown;

  try {
    document = parseYaml(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${source}: файл не является корректным YAML\n  ${message}`);
  }

  const result = policyFileSchema.safeParse(document);

  if (!result.success) {
    const issues = formatPolicyIssues(result.error)
      .map((issue) => `  - ${issue}`)
      .join("\n");

    throw new Error(`${source}: политика не прошла проверку\n${issues}${legacyHint(document)}`);
  }

  return resolvePolicyFile(result.data);
}

/**
 * Загружает и валидирует файл политик.
 *
 * @param policyFile Путь к `.yaml`/`.yml`.
 * @returns Политики, готовые к работе evaluator'а.
 * @throws Если файл нечитаем, не разбирается как YAML или не проходит схему.
 */
export function loadPolicyFile(policyFile: string): ResolvedScalingPolicy[] {
  let content: string;

  try {
    content = readFileSync(policyFile, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`не удалось прочитать файл политик ${policyFile}: ${message}`);
  }

  return parsePolicyDocument(content, policyFile);
}

/**
 * Распознаёт файл в старом формате и подсказывает, чем его сконвертировать.
 *
 * YAML 1.2 — надмножество JSON, поэтому старый `policy.example.json` разберётся успешно
 * и упрётся только в схему. Без подсказки это выглядит как набор непонятных ошибок
 * вместо «формат сменился».
 */
function legacyHint(document: unknown): string {
  if (typeof document !== "object" || document === null) {
    return "";
  }

  const keys = Object.keys(document as Record<string, unknown>);
  const looksLegacy =
    keys.includes("thresholds") || keys.includes("proxmox") || keys.includes("maxNodes");

  if (!looksLegacy) {
    return "";
  }

  return (
    "\n\nПохоже, это политика в старом формате (до версии 1). Сконвертируйте её:\n" +
    "  npm run policy:convert -- <старый-файл> > policy.yaml"
  );
}
