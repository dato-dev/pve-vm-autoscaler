import type { FastifyReply, FastifyRequest } from "fastify";

export function createAgentAuthHook(expectedToken: string) {
  return async function verifyAgentToken(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;

    if (!token || token !== expectedToken) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
}
