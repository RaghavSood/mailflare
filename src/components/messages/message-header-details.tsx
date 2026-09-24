"use client";

import { useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import dayjs from "dayjs";
import { authFetch } from "@/lib/auth/client";
import { splitEmailAddressList } from "@/lib/email/address";
import { cn } from "@/lib/utils";
import type { MessageHeaderDetailsProps, MessageHeadersResponse } from "./message-header-details-types";
import {
	formatAuthenticationCheck,
	formatTransportSecurity,
	getHiddenEnvelopeRecipient,
	summarizeAuthentication,
} from "./message-header-details-utils";

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<>
			<dt className="whitespace-nowrap text-right text-neutral-500">{label}:</dt>
			<dd className="min-w-0 break-words text-neutral-800">{children}</dd>
		</>
	);
}

function AddressList({ value }: { value: string | null | undefined }) {
	const entries = splitEmailAddressList(value);
	if (entries.length === 0) return <span className="text-neutral-500">Undisclosed recipients</span>;
	return <>{entries.join(", ")}</>;
}

/**
 * "Show details" under the sender line: every addressing field including the
 * envelope recipient, how the message was authenticated and transported, and
 * the full header list and original, loaded on first open. Render it with
 * `key={message.id}` so moving to another message starts closed.
 */
export function MessageHeaderDetails({ message }: MessageHeaderDetailsProps) {
	const [open, setOpen] = useState(false);
	const [data, setData] = useState<MessageHeadersResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [showAllHeaders, setShowAllHeaders] = useState(false);

	async function toggle() {
		const next = !open;
		setOpen(next);
		if (!next || data || loading) return;
		setLoading(true);
		try {
			const res = await authFetch(`/api/messages/${message.id}/headers`);
			const json = (await res.json()) as MessageHeadersResponse;
			setData(res.ok ? json : { error: json.error ?? "Could not load headers" });
		} catch {
			setData({ error: "Could not load headers" });
		} finally {
			setLoading(false);
		}
	}

	const details = data?.details;
	const deliveredTo = details?.deliveredTo ?? message.deliveredTo ?? null;
	const authentication = summarizeAuthentication(details?.authentication ?? []);
	const security = formatTransportSecurity(details?.transportSecurity ?? null);

	return (
		<div className="text-xs">
			<button
				type="button"
				onClick={() => void toggle()}
				className="inline-flex items-center gap-0.5 text-neutral-500 hover:text-neutral-800"
				aria-expanded={open}
			>
				{open ? "Hide details" : "Show details"}
				<ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
			</button>
			{open && (
				<div className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
					<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
						<DetailRow label="from">{message.fromAddr}</DetailRow>
						{details?.replyTo && <DetailRow label="reply-to">{details.replyTo}</DetailRow>}
						<DetailRow label="to"><AddressList value={message.toAddr} /></DetailRow>
						{message.ccAddr && <DetailRow label="cc"><AddressList value={message.ccAddr} /></DetailRow>}
						{message.bccAddr && <DetailRow label="bcc"><AddressList value={message.bccAddr} /></DetailRow>}
						{message.direction === "inbound" && deliveredTo && (
							<DetailRow label="delivered to">
								{deliveredTo}
								{getHiddenEnvelopeRecipient({ ...message, deliveredTo }) && (
									<span className="text-neutral-500"> (not listed in To or Cc)</span>
								)}
							</DetailRow>
						)}
						<DetailRow label="date">
							{dayjs(message.createdAt).format("ddd, MMM D, YYYY [at] h:mm:ss A")}
							{details?.date && <span className="text-neutral-500"> · {details.date}</span>}
						</DetailRow>
						<DetailRow label="subject">{message.subject ?? "(no subject)"}</DetailRow>
						{details?.mailedBy && (
							<DetailRow label="mailed-by">
								{details.mailedBy}
								{details.envelopeFrom && <span className="text-neutral-500"> ({details.envelopeFrom})</span>}
							</DetailRow>
						)}
						{details && details.signedBy.length > 0 && (
							<DetailRow label="signed-by">{details.signedBy.join(", ")}</DetailRow>
						)}
						{security && <DetailRow label="security">{security}</DetailRow>}
						{authentication.length > 0 && (
							<DetailRow label="authentication">
								<span className="flex flex-wrap gap-x-3 gap-y-0.5">
									{authentication.map((summary) => (
										<span key={summary.method}>
											<span
												className={cn(
													"font-medium",
													summary.tone === "pass" && "text-green-700",
													summary.tone === "fail" && "text-red-600",
												)}
											>
												{summary.label}
											</span>{" "}
											{summary.checks.map(formatAuthenticationCheck).join(", ")}
										</span>
									))}
								</span>
								{details?.authservId && (
									<span className="block text-neutral-500">checked by {details.authservId}</span>
								)}
							</DetailRow>
						)}
						{details?.listId && <DetailRow label="list">{details.listId}</DetailRow>}
						{details?.messageId && (
							<DetailRow label="message-id">
								<span className="font-mono text-[11px]">{details.messageId}</span>
							</DetailRow>
						)}
					</dl>
					{loading && <p className="mt-2 text-neutral-500">Loading headers…</p>}
					{data?.error && <p className="mt-2 text-red-600">{data.error}</p>}
					{data && !data.error && !data.hasOriginal && (
						<p className="mt-2 text-neutral-500">
							The original message is not stored, so only the fields above are available.
						</p>
					)}
					{data?.hasOriginal && (
						<div className="mt-3 flex flex-wrap items-center gap-4 border-t border-neutral-200 pt-2">
							<button
								type="button"
								onClick={() => setShowAllHeaders((value) => !value)}
								className="text-neutral-600 hover:text-neutral-900"
							>
								{showAllHeaders ? "Hide all headers" : `Show all headers (${details?.headers.length ?? 0})`}
							</button>
							<a
								href={`/api/messages/${message.id}/original`}
								target="_blank"
								rel="noreferrer"
								className="inline-flex items-center gap-1 text-neutral-600 hover:text-neutral-900"
							>
								Show original <ExternalLink className="h-3 w-3" />
							</a>
							<a
								href={`/api/messages/${message.id}/original?download=1`}
								className="text-neutral-600 hover:text-neutral-900"
							>
								Download .eml
							</a>
						</div>
					)}
					{showAllHeaders && details && (
						<pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-white p-3 font-mono text-[11px] leading-relaxed text-neutral-700">
							{details.headers.map((header) => `${header.name}: ${header.value}`).join("\n")}
						</pre>
					)}
				</div>
			)}
		</div>
	);
}
