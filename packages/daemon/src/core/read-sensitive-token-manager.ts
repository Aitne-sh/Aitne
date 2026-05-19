import { randomBytes, timingSafeEqual } from "node:crypto";

export interface ReadSensitiveTokenManager {
  issue(scope: string): string;
  revoke(scope: string): void;
  isValid(token: string): boolean;
}

/**
 * Rotates daemon read tokens per session/workdir scope.
 *
 * Each call to `issue(scope)` replaces the previously-issued token for that
 * scope, so one leaked token does not grant read-sensitive access to every
 * other concurrent agent session.
 */
export class ScopedReadSensitiveTokenManager implements ReadSensitiveTokenManager {
  private readonly tokensByScope = new Map<string, string>();

  issue(scope: string): string {
    const token = randomBytes(24).toString("base64url");
    this.tokensByScope.set(scope, token);
    return token;
  }

  revoke(scope: string): void {
    this.tokensByScope.delete(scope);
  }

  isValid(token: string): boolean {
    for (const current of this.tokensByScope.values()) {
      if (
        token.length === current.length
        && timingSafeEqual(Buffer.from(token), Buffer.from(current))
      ) {
        return true;
      }
    }
    return false;
  }
}
