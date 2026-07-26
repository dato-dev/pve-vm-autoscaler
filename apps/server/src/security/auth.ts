import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const BEARER_PREFIX = "Bearer ";

/**
 * preHandler-хук аутентификации агента.
 *
 * Возвращает `reply`, если запрос отклонён, и `undefined`, если проверка пройдена.
 * Тип возвращаемого значения здесь значим: именно по возврату `reply` Fastify
 * понимает, что жизненный цикл нужно оборвать.
 */
export type AgentAuthHook = (
  request: FastifyRequest,
  reply: FastifyReply
) => Promise<FastifyReply | undefined>;

/**
 * Считает SHA-256 от токена.
 *
 * `timingSafeEqual` требует буферы одинаковой длины и бросает исключение, если длины
 * разошлись. На сырых токенах это само по себе утечка: по факту исключения отличается
 * «неверный токен той же длины» от «токен другой длины». Хеширование приводит любое
 * значение к 32 байтам и убирает этот канал.
 *
 * @param token Произвольная строка токена.
 * @returns 32-байтовый дайджест.
 */
function digest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Создаёт preHandler-хук, проверяющий Bearer-токен агента.
 *
 * @param expectedToken Ожидаемый токен из конфигурации сервера.
 * @returns Хук, который при неуспехе отвечает 401 и возвращает `reply`, останавливая обработку.
 */
export function createAgentAuthHook(expectedToken: string): AgentAuthHook {
  // Дайджест ожидаемого токена считается один раз, а не на каждый запрос.
  const expectedDigest = digest(expectedToken);

  return async function verifyAgentToken(request, reply) {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith(BEARER_PREFIX)
      ? authorization.slice(BEARER_PREFIX.length)
      : undefined;

    // Сравнение за постоянное время: обычное !== выходит на первом различающемся
    // байте, из-за чего по времени ответа токен подбирается посимвольно.
    if (!token || !timingSafeEqual(digest(token), expectedDigest)) {
      // `return` обязателен. Без него Fastify продолжает жизненный цикл и выполняет
      // обработчик маршрута: неаутентифицированный запрос доходил до записи в БД,
      // а 202 не отдавался лишь потому, что ответ уже был отправлен.
      return reply.code(401).send({ error: "unauthorized" });
    }

    return undefined;
  };
}
