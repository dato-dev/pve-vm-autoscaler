import { describe, expect, it } from "vitest";
import {
  bytesToMib,
  bytesToProxmoxDiskSize,
  parseDuration,
  parsePercent,
  parseQuantity
} from "./units.js";

describe("parseDuration", () => {
  it("разбирает одиночные единицы", () => {
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("7d")).toBe(604_800);
  });

  it("разбирает составные значения", () => {
    expect(parseDuration("1h30m")).toBe(5400);
    expect(parseDuration("1d12h")).toBe(129_600);
    expect(parseDuration("1m30s")).toBe(90);
  });

  it("трактует голое число как секунды ради совместимости со старым форматом", () => {
    expect(parseDuration("120")).toBe(120);
    expect(parseDuration(120)).toBe(120);
  });

  it("допускает ноль — это валидный cooldown", () => {
    expect(parseDuration("0s")).toBe(0);
    expect(parseDuration(0)).toBe(0);
  });

  it("не принимает пустую строку", () => {
    expect(() => parseDuration("")).toThrow(/не может быть пустой/);
    expect(() => parseDuration("   ")).toThrow(/не может быть пустой/);
  });

  it("не принимает неизвестные единицы", () => {
    expect(() => parseDuration("5x")).toThrow(/s, m, h или d/);
    expect(() => parseDuration("5ms")).toThrow(/s, m, h или d/);
    expect(() => parseDuration("минута")).toThrow(/s, m, h или d/);
  });

  it("не принимает дробные и отрицательные значения", () => {
    expect(() => parseDuration("1.5h")).toThrow();
    expect(() => parseDuration("-5m")).toThrow();
    expect(() => parseDuration(-1)).toThrow(/неотрицательным/);
    expect(() => parseDuration(1.5)).toThrow(/целым/);
  });

  it("сообщает исходное значение в тексте ошибки", () => {
    // Оператор должен увидеть, какое именно поле он написал неверно.
    expect(() => parseDuration("5x")).toThrow(/«5x»/);
  });
});

describe("parseQuantity", () => {
  it("разбирает двоичные приставки", () => {
    expect(parseQuantity("1Ki")).toBe(1024);
    expect(parseQuantity("512Mi")).toBe(512 * 1024 ** 2);
    expect(parseQuantity("2Gi")).toBe(2 * 1024 ** 3);
    expect(parseQuantity("1Ti")).toBe(1024 ** 4);
  });

  it("разбирает десятичные приставки", () => {
    expect(parseQuantity("1k")).toBe(1000);
    expect(parseQuantity("2G")).toBe(2 * 1000 ** 3);
  });

  it("различает Gi и G — на дисках расхождение уже заметное", () => {
    expect(parseQuantity("1Gi") - parseQuantity("1G")).toBe(73_741_824);
  });

  it("трактует значение без приставки как байты", () => {
    expect(parseQuantity("1024")).toBe(1024);
    expect(parseQuantity(2048)).toBe(2048);
  });

  it("принимает дробные значения", () => {
    expect(parseQuantity("1.5Gi")).toBe(1.5 * 1024 ** 3);
    expect(parseQuantity("0.5Mi")).toBe(512 * 1024);
  });

  it("не принимает неизвестные приставки и мусор", () => {
    expect(() => parseQuantity("2GB")).toThrow(/Ki, Mi, Gi, Ti/);
    expect(() => parseQuantity("много")).toThrow(/Ki, Mi, Gi, Ti/);
    expect(() => parseQuantity("")).toThrow(/не может быть пустой/);
  });

  it("не принимает отрицательные значения", () => {
    expect(() => parseQuantity("-1Gi")).toThrow();
    expect(() => parseQuantity(-1)).toThrow(/неотрицательным/);
  });
});

describe("parsePercent", () => {
  it("разбирает целые и дробные проценты", () => {
    expect(parsePercent("60%")).toBe(60);
    expect(parsePercent("99.5%")).toBe(99.5);
    expect(parsePercent("0%")).toBe(0);
    expect(parsePercent("100%")).toBe(100);
  });

  it("требует знак процента, чтобы не путать порог с числом ядер", () => {
    // В политике рядом стоят cpu: 2 (ядра шаблона) и cpu: 60% (порог загрузки).
    // Без суффикса эти поля читались бы одинаково, а значат разное.
    expect(() => parsePercent(60)).toThrow(/со знаком «%»/);
    expect(() => parsePercent("60")).toThrow(/со знаком «%»/);
  });

  it("подсказывает в ошибке, как записать значение верно", () => {
    expect(() => parsePercent(60)).toThrow(/«60%»/);
  });

  it("не принимает значения больше 100", () => {
    expect(() => parsePercent("101%")).toThrow(/не может превышать 100/);
  });

  it("не принимает мусор", () => {
    expect(() => parsePercent("много%")).toThrow(/ожидается число/);
    expect(() => parsePercent("%")).toThrow(/ожидается число/);
    expect(() => parsePercent("")).toThrow(/ожидается число/);
  });
});

describe("перевод в единицы Proxmox", () => {
  it("переводит байты в мебибайты для параметра memory", () => {
    expect(bytesToMib(2 * 1024 ** 3)).toBe(2048);
    expect(bytesToMib(512 * 1024 ** 2)).toBe(512);
  });

  it("округляет мебибайты вверх и не отдаёт ноль", () => {
    // Proxmox не примет memory=0, а округление вниз на дробном значении дало бы ноль.
    expect(bytesToMib(1)).toBe(1);
    expect(bytesToMib(1024 ** 2 + 1)).toBe(2);
  });

  it("переводит байты в размер диска для Proxmox", () => {
    // API resize принимает `20G`, где G означает гибибайты, несмотря на обозначение.
    expect(bytesToProxmoxDiskSize(20 * 1024 ** 3)).toBe("20G");
    expect(bytesToProxmoxDiskSize(1024 ** 3)).toBe("1G");
  });

  it("округляет размер диска вверх: уменьшить диск Proxmox не позволит", () => {
    expect(bytesToProxmoxDiskSize(1024 ** 3 + 1)).toBe("2G");
    expect(bytesToProxmoxDiskSize(1)).toBe("1G");
  });
});
