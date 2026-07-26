import { type ResolvedScalingPolicy, type ScalingDecision } from "@pve-vm-autoscaler/shared";
import type { WindowAverages } from "../db/repository.js";

/**
 * Решает, нужно ли добавить ноду.
 *
 * Функция чистая: никакого I/O, а момент оценки приходит параметром — иначе тесты
 * стали бы недетерминированными.
 *
 * **Порядок проверок значим.** Выключенная политика и активный cooldown отсекаются
 * раньше порогов: cooldown существует именно чтобы не реагировать на нагрузку, поэтому
 * проверять пороги перед ним бессмысленно. `nodes.max` проверяется раньше `nodes.min`,
 * чтобы конфликтующие границы не приводили к бесконечному росту.
 *
 * @param policy Политика с уже подставленным шаблоном машины.
 * @param averages Средние по нодам за окно оценки.
 * @param knownNodes Число живых нод, подходящих под селектор.
 * @param cooldownActive Есть ли недавнее событие масштабирования по этой политике.
 * @param evaluatedAt Момент оценки; по умолчанию текущее время.
 * @returns Решение с человекочитаемой причиной — она попадает в лог и в scaling event.
 */
export function evaluateScalingDecision(
  policy: ResolvedScalingPolicy,
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

  const decide = (shouldScale: boolean, reason: string): ScalingDecision => ({
    policyName: policy.name,
    shouldScale,
    reason,
    observedNodes: averages.observedNodes,
    averages: observed,
    evaluatedAt: evaluatedAt.toISOString()
  });

  if (!policy.enabled) {
    return decide(false, "policy is disabled");
  }

  if (cooldownActive) {
    return decide(false, "cooldown is active");
  }

  if (knownNodes >= policy.nodes.max) {
    return decide(false, `max nodes reached (${knownNodes}/${policy.nodes.max})`);
  }

  if (knownNodes < policy.nodes.min) {
    return decide(true, `known nodes below nodes.min (${knownNodes}/${policy.nodes.min})`);
  }

  // Ноль наблюдаемых нод — это «данных нет», а не «нагрузка нулевая»:
  // масштабироваться вслепую нельзя. Добор до nodes.min отработал выше и сюда не доходит.
  if (averages.observedNodes === 0) {
    return decide(false, "no metrics observed in evaluation window");
  }

  const { cpu, memory, disk } = policy.scaleUp;

  if (cpu !== undefined && averages.cpuPercent !== null && averages.cpuPercent >= cpu) {
    return decide(true, `cpu average ${averages.cpuPercent.toFixed(1)} >= ${cpu}`);
  }

  if (memory !== undefined && averages.memoryPercent !== null && averages.memoryPercent >= memory) {
    return decide(true, `memory average ${averages.memoryPercent.toFixed(1)} >= ${memory}`);
  }

  if (disk !== undefined && averages.diskPercent !== null && averages.diskPercent >= disk) {
    return decide(true, `disk average ${averages.diskPercent.toFixed(1)} >= ${disk}`);
  }

  return decide(false, "thresholds are healthy");
}
