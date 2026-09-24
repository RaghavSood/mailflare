import type { Message } from "@/hooks/types";
import type { AuthenticationCheck, MessageHeaderDetails } from "@/lib/email/header-types";

export type MessageHeaderDetailsProps = {
	message: Pick<Message, "id" | "direction" | "fromAddr" | "toAddr" | "ccAddr" | "bccAddr" | "subject" | "createdAt" | "deliveredTo">;
};

export type MessageHeadersResponse = {
	details?: MessageHeaderDetails;
	hasOriginal?: boolean;
	error?: string;
};

export type AuthenticationSummary = {
	method: string;
	label: string;
	checks: AuthenticationCheck[];
	/** pass when every check for the method passed, fail when any failed, otherwise neutral. */
	tone: "pass" | "fail" | "neutral";
};
