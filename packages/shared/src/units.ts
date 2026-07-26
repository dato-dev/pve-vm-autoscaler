/**
 * Парсеры единиц измерения для policy.
 *
 * Политику редактирует оператор, поэтому единица измерения должна быть видна в самом
 * значении: `cooldown: 5m` вместо `cooldownSeconds: 300`, `memory: 2Gi` вместо
 * `memoryMb: 2048`. Имя поля перестаёт нести единицу, и переименование поля больше
 * не меняет смысл числа.
 *
 * Все функции бросают `Error` с сообщением, пригодным для показа пользователю:
 * оно попадает в вывод `validate` и в ошибку загрузки конфигурации.
 */

const DURATION_UNITS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60
};

/** Последовательность вида `1h30m`: одна или несколько пар «число + единица». */
const DURATION_FORMAT = /^(?:\d+[smhd])+$/;
const DURATION_PART = /(\d+)([smhd])/g;

const QUANTITY_UNITS: Record<string, number> = {
  // Десятичные приставки (СИ).
  k: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  // Двоичные приставки (IEC) — то, что обычно и имеют в виду для памяти и дисков.
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4
};

// Двоичные приставки идут первыми: иначе `Gi` совпало бы с `G`, а `i` осталось лишним.
const QUANTITY_FORMAT = /^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|k|M|G|T)?$/;

const PERCENT_FORMAT = /^(\d+(?:\.\d+)?)\s*%$/;

/**
 * Разбирает длительность в секунды.
 *
 * Принимает строку с единицами (`30s`, `5m`, `2h`, `7d`) и составные значения (`1h30m`).
 * Голое число трактуется как секунды — это оставлено ради совместимости со старым
 * форматом, где поля назывались `*Seconds`.
 *
 * @param input Строка вида `5m` или число секунд.
 * @returns Длительность в секундах.
 * @throws Если строка пустая, содержит неизвестную единицу, дробное или отрицательное значение.
 */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input < 0) {
      throw new Error(
        `длительность должна быть целым неотрицательным числом секунд, получено «${input}»`
      );
    }
    return input;
  }

  const value = input.trim();

  if (value === "") {
    throw new Error("длительность не может быть пустой строкой, например: 30s, 5m, 2h, 1h30m");
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  if (!DURATION_FORMAT.test(value)) {
    throw new Error(
      `не удалось разобрать длительность «${value}»: ожидается число с единицей s, m, h или d, ` +
        "например 30s, 5m, 2h, 1h30m"
    );
  }

  let totalSeconds = 0;

  for (const part of value.matchAll(DURATION_PART)) {
    const [, amount, unit] = part;
    if (amount === undefined || unit === undefined) {
      continue;
    }

    const multiplier = DURATION_UNITS[unit];
    if (multiplier === undefined) {
      throw new Error(`неизвестная единица длительности «${unit}» в значении «${value}»`);
    }

    totalSeconds += Number(amount) * multiplier;
  }

  return totalSeconds;
}

/**
 * Разбирает объём в байты.
 *
 * Поддерживает двоичные приставки (`Ki`, `Mi`, `Gi`, `Ti`) и десятичные (`k`, `M`, `G`, `T`).
 * Различие не косметическое: `1Gi` это 1073741824 байт, а `1G` — 1000000000, и на объёмах
 * дисков расхождение уже заметное. Значение без приставки трактуется как байты.
 *
 * @param input Строка вида `2Gi` или число байт.
 * @returns Объём в байтах, округлённый до целого.
 * @throws Если строка пустая, содержит неизвестную приставку или отрицательное значение.
 */
export function parseQuantity(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`объём должен быть неотрицательным числом байт, получено «${input}»`);
    }
    return Math.round(input);
  }

  const value = input.trim();

  if (value === "") {
    throw new Error("объём не может быть пустой строкой, например: 512Mi, 2Gi, 20Gi");
  }

  const match = QUANTITY_FORMAT.exec(value);
  if (!match) {
    throw new Error(
      `не удалось разобрать объём «${value}»: ожидается число с приставкой Ki, Mi, Gi, Ti ` +
        "(двоичные) либо k, M, G, T (десятичные), например 2Gi"
    );
  }

  const [, amount, unit] = match;
  if (amount === undefined) {
    throw new Error(`не удалось разобрать объём «${value}»`);
  }

  const multiplier = unit === undefined ? 1 : QUANTITY_UNITS[unit];
  if (multiplier === undefined) {
    throw new Error(`неизвестная приставка «${unit}» в значении «${value}»`);
  }

  return Math.round(Number(amount) * multiplier);
}

/**
 * Разбирает процент.
 *
 * Суффикс `%` обязателен намеренно. В политике рядом стоят `cpu: 2` (ядра в шаблоне машины)
 * и `cpu: 60%` (порог загрузки), и без суффикса эти два поля читались бы одинаково,
 * а означали разное.
 *
 * @param input Строка вида `60%`.
 * @returns Число в диапазоне 0..100.
 * @throws Если суффикс отсутствует или значение выходит за границы диапазона.
 */
export function parsePercent(input: string | number): number {
  if (typeof input === "number") {
    throw new Error(
      `процент записывается со знаком «%», получено «${input}»: напишите «${input}%», ` +
        "чтобы не путать с количеством ядер"
    );
  }

  const value = input.trim();
  const match = PERCENT_FORMAT.exec(value);

  if (!match) {
    throw new Error(
      `не удалось разобрать процент «${value}»: ожидается число со знаком «%», например 60%`
    );
  }

  const [, amount] = match;
  if (amount === undefined) {
    throw new Error(`не удалось разобрать процент «${value}»`);
  }

  const percent = Number(amount);
  if (percent > 100) {
    throw new Error(`процент не может превышать 100, получено «${value}»`);
  }

  return percent;
}

/**
 * Переводит байты в мебибайты — в этих единицах Proxmox принимает объём памяти VM.
 *
 * @param bytes Объём в байтах.
 * @returns Целое число мебибайт, округлённое вверх, но не меньше 1.
 */
export function bytesToMib(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / 1024 ** 2));
}

/**
 * Переводит байты в размер диска для Proxmox.
 *
 * API `resize` принимает строку вида `20G`, где `G` означает гибибайты,
 * а не гигабайты — несмотря на обозначение.
 *
 * @param bytes Объём в байтах.
 * @returns Строка вида `20G`.
 */
export function bytesToProxmoxDiskSize(bytes: number): string {
  return `${Math.max(1, Math.ceil(bytes / 1024 ** 3))}G`;
}
