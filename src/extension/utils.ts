import * as crypto from "crypto";

/**
 * Generate a cryptographically secure nonce for use in Content Security Policy headers.
 */
export function getNonce(): string {
  return crypto.randomBytes(16).toString("base64url");
}
