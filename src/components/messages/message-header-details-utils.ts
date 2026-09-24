import { getEmailAddressList } from "@/lib/email/address";
import type { AuthenticationCheck } from "@/lib/email/header-types";
import type { AuthenticationSummary, MessageHeaderDetailsProps } from "./message-header-details-types";

const METHOD_LABELS: Record<string, string> = { spf: "SPF", dkim: "DKIM", dmarc: "DMARC", arc: "ARC" };
const PASSING = new Set(["pass", "bestguesspass"]);
const FAILING = new Set(["fail", "softfail", "permerror", "temperror", "hardfail"]);

/**
 * The envelope recipient when the headers do not already show it: mail that
 * reached an alias or catch-all address as a Bcc, through a list, or with
 * "Undisclosed recipients" in To.
 */
export function getHiddenEnvelopeRecipient(message: MessageHeaderDetailsProps["message"]): string | null {
	if (message.direction !== "inbound" || !message.deliveredTo) return null;
	const deliveredTo = message.deliveredTo.toLowerCase();
	const listed = new Set([...getEmailAddressList(message.toAddr), ...getEmailAddressList(message.ccAddr)]);
	return listed.has(deliveredTo) ? null : deliveredTo;
}

/**
 * One valid DKIM signature is enough (a relay that rewrites the body breaks the
 * others), so DKIM passes if any signature does. Other methods fail if any check did.
 */
function getTone(method: string, checks: AuthenticationCheck[]): AuthenticationSummary["tone"] {
	if (method === "dkim" && checks.some((check) => PASSING.has(check.result))) return "pass";
	if (checks.some((check) => FAILING.has(check.result))) return "fail";
	return checks.every((check) => PASSING.has(check.result)) ? "pass" : "neutral";
}

/** SPF, DKIM, DMARC and ARC in that order, each with its individual results. */
export function summarizeAuthentication(checks: AuthenticationCheck[]): AuthenticationSummary[] {
	const byMethod = new Map<string, AuthenticationCheck[]>();
	for (const check of checks) {
		if (!METHOD_LABELS[check.method]) continue;
		byMethod.set(check.method, [...(byMethod.get(check.method) ?? []), check]);
	}
	const order = Object.keys(METHOD_LABELS);
	return [...byMethod.entries()]
		.sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
		.map(([method, methodChecks]) => ({
			method,
			label: METHOD_LABELS[method],
			checks: methodChecks,
			tone: getTone(method, methodChecks),
		}));
}

export function formatAuthenticationCheck(check: AuthenticationCheck): string {
	return check.domain ? `${check.result} (${check.domain})` : check.result;
}

export function formatTransportSecurity(value: string | null): string | null {
	if (!value) return null;
	return value === "TLS" ? "Standard encryption (TLS)" : `Standard encryption (${value})`;
}
