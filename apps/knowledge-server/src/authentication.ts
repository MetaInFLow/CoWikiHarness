import type { User } from "@a2a-js/sdk/server";
import type { Request, RequestHandler, Response } from "express";
import type { PostgresKnowledgeStore } from "@openlifewiki/adapters";
import type { Principal } from "@openlifewiki/protocol";

const authenticatedUser = Symbol("cowikiharness.authenticated-user");

type AuthenticatedRequest = Request & { [authenticatedUser]?: AuthenticatedA2AUser };

export class AuthenticatedA2AUser implements User {
  readonly isAuthenticated = true;

  constructor(readonly principal: Principal) {}

  get userName(): string {
    return this.principal.principalId;
  }
}

export function createBearerAuthentication(input: {
  readonly store: PostgresKnowledgeStore;
  readonly now: () => Date;
  readonly onInfrastructureFailure?: (
    request: Request,
    response: Response,
  ) => boolean | Promise<boolean>;
}): RequestHandler {
  return async (request, response, next) => {
    const token = extractBearer(request.headers.authorization);
    if (token === null) return unauthorized(response);
    let principal: Principal | null;
    try {
      principal = await input.store.authenticate(token, input.now());
    } catch {
      try {
        if (await input.onInfrastructureFailure?.(request, response) === true) return;
      } catch {
        // Preserve the existing fail-closed authentication response.
      }
      return unauthorized(response);
    }
    if (principal === null) return unauthorized(response);
    (request as AuthenticatedRequest)[authenticatedUser] = new AuthenticatedA2AUser(principal);
    next();
  };
}

export async function buildAuthenticatedUser(request: Request): Promise<AuthenticatedA2AUser> {
  const user = (request as AuthenticatedRequest)[authenticatedUser];
  if (user === undefined) throw new Error("Authentication is required");
  return user;
}

export function requireAuthenticatedUser(user: User | undefined): AuthenticatedA2AUser {
  if (!(user instanceof AuthenticatedA2AUser) || !user.isAuthenticated) {
    throw new Error("Authentication is required");
  }
  return user;
}

function extractBearer(value: string | undefined): string | null {
  if (value === undefined || value.includes(",")) return null;
  const match = /^Bearer ([^\s]+)$/iu.exec(value);
  return match?.[1] ?? null;
}

function unauthorized(response: import("express").Response): void {
  const requestId = response.getHeader("X-Request-ID");
  response.status(401).type("application/json").send({
    error: "unauthorized",
    ...(typeof requestId === "string" ? { requestId } : {}),
  });
}
