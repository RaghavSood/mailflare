export type RawHeader = {
	name: string;
	value: string;
};

export type AuthenticationCheck = {
	/** spf, dkim, dmarc, arc, ... */
	method: string;
	/** pass, fail, softfail, none, ... lowercased. */
	result: string;
	/** The domain the result is about: header.d / header.i for DKIM, smtp.mailfrom for SPF, header.from for DMARC. */
	domain: string | null;
};

/** What a "show details" panel needs, read from a message's own headers. */
export type MessageHeaderDetails = {
	/** SMTP RCPT TO recorded by the receiving server (X-Original-To, X-Delivered-To, Envelope-To, Delivered-To). */
	deliveredTo: string | null;
	/** SMTP MAIL FROM (Return-Path). */
	envelopeFrom: string | null;
	replyTo: string | null;
	date: string | null;
	messageId: string | null;
	listId: string | null;
	/** Server that evaluated the authentication results below. */
	authservId: string | null;
	authentication: AuthenticationCheck[];
	/** Domains with a passing DKIM signature. */
	signedBy: string[];
	/** Domain of the envelope sender. */
	mailedBy: string | null;
	/** e.g. "TLSv1.3"; null when the receiving hop did not record it. */
	transportSecurity: string | null;
	headers: RawHeader[];
};
