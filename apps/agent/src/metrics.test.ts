import { describe, expect, it } from "vitest";
import { parseMemInfo, toMemoryUsage } from "./metrics.js";

/**
 * Фрагмент /proc/meminfo с прогретой машины: почти вся память отдана под page cache,
 * поэтому MemFree мизерный, а MemAvailable — большой. Ровно этот случай и ломал
 * прежнюю реализацию на os.freemem().
 */
const WARM_CACHE_MEMINFO = `MemTotal:       16316456 kB
MemFree:          326164 kB
MemAvailable:   12045208 kB
Buffers:          158912 kB
Cached:         11894132 kB
SwapCached:            0 kB
Active:          2841236 kB
`;

describe("parseMemInfo", () => {
  it("читает MemTotal и MemAvailable, переводя кибибайты в байты", () => {
    const reading = parseMemInfo(WARM_CACHE_MEMINFO);

    expect(reading).toEqual({
      totalBytes: 16_316_456 * 1024,
      availableBytes: 12_045_208 * 1024
    });
  });

  it("даёт принципиально другой процент, чем счёт по MemFree", () => {
    const reading = parseMemInfo(WARM_CACHE_MEMINFO);
    if (!reading) {
      throw new Error("ожидались показания памяти");
    }

    const byAvailable = toMemoryUsage(reading).usagePercent;

    // Как считалось раньше: total - MemFree.
    const byFree = toMemoryUsage({
      totalBytes: 16_316_456 * 1024,
      availableBytes: 326_164 * 1024
    }).usagePercent;

    // 26% против 98%: при пороге memoryPercent = 80 старый счёт давал
    // непрерывные ложные scale-up на простаивающей машине.
    expect(byAvailable).toBeCloseTo(26.2, 1);
    expect(byFree).toBeCloseTo(98.0, 1);
  });

  it("возвращает undefined, если MemAvailable нет (ядро старше 3.14)", () => {
    const old = `MemTotal:       16316456 kB
MemFree:          326164 kB
Buffers:          158912 kB
`;

    expect(parseMemInfo(old)).toBeUndefined();
  });

  it("возвращает undefined, если нет MemTotal", () => {
    expect(parseMemInfo("MemAvailable:   12045208 kB\n")).toBeUndefined();
  });

  it("возвращает undefined на пустом и мусорном содержимом", () => {
    expect(parseMemInfo("")).toBeUndefined();
    expect(parseMemInfo("что-то совсем не то\n<html>\n")).toBeUndefined();
  });

  it("не путает MemTotal с похожими ключами", () => {
    // MemFree и MemTotalHuge не должны попасть в результат вместо нужных полей.
    const tricky = `MemTotalHuge:    9999999 kB
MemTotal:       1048576 kB
MemAvailableNow: 7777777 kB
MemAvailable:    524288 kB
`;

    expect(parseMemInfo(tricky)).toEqual({
      totalBytes: 1_048_576 * 1024,
      availableBytes: 524_288 * 1024
    });
  });
});

describe("toMemoryUsage", () => {
  it("считает занятое как разницу между всего и доступно", () => {
    const usage = toMemoryUsage({ totalBytes: 1000, availableBytes: 250 });

    expect(usage).toEqual({
      totalBytes: 1000,
      usedBytes: 750,
      usagePercent: 75
    });
  });

  it("не уходит в минус, если доступно больше, чем всего", () => {
    // Показания могут разъехаться между двумя чтениями /proc/meminfo.
    // Отрицательный usedBytes не прошёл бы Zod-схему на сервере.
    const usage = toMemoryUsage({ totalBytes: 1000, availableBytes: 1500 });

    expect(usage.usedBytes).toBe(0);
    expect(usage.usagePercent).toBe(0);
  });

  it("не делит на ноль при нулевом объёме памяти", () => {
    const usage = toMemoryUsage({ totalBytes: 0, availableBytes: 0 });

    expect(usage.usagePercent).toBe(0);
    expect(Number.isNaN(usage.usagePercent)).toBe(false);
  });

  it("держит процент в границах, которые примет схема метрик", () => {
    const usage = toMemoryUsage({ totalBytes: 1000, availableBytes: -500 });

    expect(usage.usagePercent).toBeLessThanOrEqual(100);
    expect(usage.usagePercent).toBeGreaterThanOrEqual(0);
  });
});
