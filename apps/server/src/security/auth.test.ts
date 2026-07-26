import { describe, expect, it } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createAgentAuthHook } from "./auth.js";

const EXPECTED_TOKEN = "correct-horse-battery-staple";

interface SentResponse {
  statusCode?: number;
  payload?: unknown;
}

/** Минимальный reply: фиксирует код и тело, возвращает себя для чейнинга. */
function fakeReply(): { reply: FastifyReply; sent: SentResponse } {
  const sent: SentResponse = {};

  const reply = {
    code(statusCode: number) {
      sent.statusCode = statusCode;
      return reply;
    },
    send(payload: unknown) {
      sent.payload = payload;
      return reply;
    }
  };

  return { reply: reply as unknown as FastifyReply, sent };
}

function fakeRequest(authorization?: string): FastifyRequest {
  const headers = authorization === undefined ? {} : { authorization };
  return { headers } as unknown as FastifyRequest;
}

describe("createAgentAuthHook", () => {
  it("пропускает запрос с верным токеном, ничего не отвечая", async () => {
    const hook = createAgentAuthHook(EXPECTED_TOKEN);
    const { reply, sent } = fakeReply();

    const result = await hook(fakeRequest(`Bearer ${EXPECTED_TOKEN}`), reply);

    // undefined означает «жизненный цикл продолжается» — запрос дойдёт до обработчика.
    expect(result).toBeUndefined();
    expect(sent.statusCode).toBeUndefined();
  });

  it("отвечает 401 и ВОЗВРАЩАЕТ reply, обрывая жизненный цикл", async () => {
    const hook = createAgentAuthHook(EXPECTED_TOKEN);
    const { reply, sent } = fakeReply();

    const result = await hook(fakeRequest("Bearer wrong-token"), reply);

    expect(sent.statusCode).toBe(401);
    expect(sent.payload).toEqual({ error: "unauthorized" });
    // Ключевая проверка. Раньше хук отвечал, но возвращал undefined — Fastify
    // продолжал обработку, и неаутентифицированный запрос доходил до записи в БД.
    expect(result).toBe(reply);
  });

  it("отклоняет запрос без заголовка Authorization", async () => {
    const hook = createAgentAuthHook(EXPECTED_TOKEN);
    const { reply, sent } = fakeReply();

    const result = await hook(fakeRequest(), reply);

    expect(sent.statusCode).toBe(401);
    expect(result).toBe(reply);
  });

  it("отклоняет схему, отличную от Bearer", async () => {
    const hook = createAgentAuthHook(EXPECTED_TOKEN);
    const { reply, sent } = fakeReply();

    const result = await hook(fakeRequest(`Basic ${EXPECTED_TOKEN}`), reply);

    expect(sent.statusCode).toBe(401);
    expect(result).toBe(reply);
  });

  it("отклоняет токен другой длины, не бросая исключение", async () => {
    // Граничный случай ради timingSafeEqual: на буферах разной длины он кидает
    // RangeError. Токены сравниваются по SHA-256, поэтому длина всегда одинаковая
    // и префикс верного токена отвергается штатным 401, а не падением с 500.
    const hook = createAgentAuthHook(EXPECTED_TOKEN);
    const { reply, sent } = fakeReply();

    const result = await hook(fakeRequest("Bearer correct"), reply);

    expect(sent.statusCode).toBe(401);
    expect(result).toBe(reply);
  });

  it("отклоняет пустой токен после Bearer", async () => {
    const hook = createAgentAuthHook(EXPECTED_TOKEN);
    const { reply, sent } = fakeReply();

    const result = await hook(fakeRequest("Bearer "), reply);

    expect(sent.statusCode).toBe(401);
    expect(result).toBe(reply);
  });
});
