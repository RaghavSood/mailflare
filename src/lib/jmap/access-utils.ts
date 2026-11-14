import { hasScope } from "@/lib/api/key-auth-utils";

export type JmapAccess = "full" | "read";

/**
 * What an API key may do over JMAP: `jmap` reads and writes (sending
 * included), `jmap-read` only reads. A key holding both gets full access.
 */
export function jmapAccess(scopes: string[]): JmapAccess | null {
	if (hasScope(scopes, "jmap")) return "full";
	if (scopes.includes("jmap-read")) return "read";
	return null;
}

/** Methods that change the account. A read-only key gets `accountReadOnly` (RFC 8620 §5.3) for each. */
export const JMAP_WRITE_METHODS = new Set(["Mailbox/set", "Email/set", "Email/import", "Email/copy", "Identity/set", "EmailSubmission/set"]);
