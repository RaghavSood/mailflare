"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import { parseApiKeyScopes } from "@/app/(admin)/api-keys/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ApiKeySummary } from "./types";
import { createJmapApiKey, listApiKeys, revokeApiKey } from "./utils";

/**
 * Settings > Account card for connecting an external mail app over JMAP.
 * Mints an API key with the `jmap` scope (or `jmap-read`, for apps and AI
 * assistants that should only read), shows the details once, and lists
 * the account's keys so any of them can be revoked.
 */
export function EmailClientsSettings() {
	const [name, setName] = useState("");
	const [readOnly, setReadOnly] = useState(false);
	const [key, setKey] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);
	const server = typeof window !== "undefined" ? window.location.origin : "";
	const qc = useQueryClient();
	const keysQuery = useQuery({ queryKey: ["api-keys"], queryFn: listApiKeys });
	const keys = keysQuery.data ?? null;
	const revoke = useMutation({
		mutationFn: (item: ApiKeySummary) => revokeApiKey(item.id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
	});
	const listError = keysQuery.error ?? revoke.error;

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			setKey(await createJmapApiKey(name.trim() || "Mail app", readOnly));
			setName("");
			setReadOnly(false);
			await qc.invalidateQueries({ queryKey: ["api-keys"] });
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not create a key");
		} finally {
			setBusy(false);
		}
	}

	function confirmRevoke(item: ApiKeySummary) {
		if (!window.confirm(`Revoke "${item.name}"? Apps using this key will stop working immediately.`)) return;
		revoke.mutate(item);
	}

	function copy(label: string, value: string) {
		void navigator.clipboard.writeText(value).then(() => setCopied(label));
	}

	return (
		<div className="space-y-4">
			<p className="text-sm text-neutral-500">
				Apps that speak JMAP (Mailtemi, Twake Mail, aerc, and others) can read and send your mail. Point the app at this server and sign in with your email address and an API key as the password. A read-only password can search and read mail but cannot send, move, delete or mark anything, which suits AI assistants and MCP servers.
			</p>
			{key ? (
				<div className="space-y-3 rounded-2xl bg-neutral-50 p-4">
					<Field label="Server" value={server} onCopy={copy} copied={copied} />
					<Field label="Username" value="any value" onCopy={copy} copied={copied} />
					<Field label="Password (API key)" value={key} onCopy={copy} copied={copied} mono />
					<p className="text-xs text-neutral-500">
						This key is shown once. It can be revoked from the list below at any time. Session discovery is at <code>{server}/.well-known/jmap</code>.
					</p>
					<Button type="button" variant="outline" size="sm" onClick={() => setKey(null)}>
						Done
					</Button>
				</div>
			) : (
				<form onSubmit={submit} className="flex flex-wrap items-end gap-3">
					<div className="min-w-56 flex-1 space-y-2">
						<Label htmlFor="jmap-key-name">Device or app name</Label>
						<Input id="jmap-key-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Phone" />
					</div>
					<label className="flex h-10 items-center gap-2 text-sm text-neutral-700">
						<Checkbox checked={readOnly} onChange={(event) => setReadOnly(event.target.checked)} />
						Read only
					</label>
					<Button type="submit" disabled={busy}>
						<KeyRound className="h-4 w-4" />
						{busy ? "Creating..." : "Create app password"}
					</Button>
				</form>
			)}
			{error && <p className="text-sm text-red-600">{error}</p>}
			<div className="space-y-2">
				<p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Your API keys</p>
				{listError && <p className="text-sm text-red-600">{listError instanceof Error ? listError.message : "Something went wrong"}</p>}
				{keys === null && !listError && <p className="text-sm text-neutral-400">Loading...</p>}
				{keys?.length === 0 && <p className="text-sm text-neutral-400">No API keys yet.</p>}
				{keys?.map((item) => (
					<div key={item.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-neutral-200 bg-white px-3 py-2">
						<span className="min-w-0 flex-1">
							<span className="block truncate text-sm font-medium text-neutral-900">{item.name}</span>
							<span className="block truncate font-mono text-xs text-neutral-500">{item.prefix}...</span>
						</span>
						<span className="flex flex-wrap gap-1">
							{parseApiKeyScopes(item.scopes).map((scope) => (
								<Badge key={scope} variant="outline">
									{scope}
								</Badge>
							))}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => confirmRevoke(item)}
							disabled={revoke.isPending && revoke.variables?.id === item.id}
							aria-label={`Revoke ${item.name}`}
						>
							<Trash2 className="h-4 w-4" />
							{revoke.isPending && revoke.variables?.id === item.id ? "Revoking..." : "Revoke"}
						</Button>
					</div>
				))}
			</div>
		</div>
	);
}

function Field({ label, value, onCopy, copied, mono }: { label: string; value: string; onCopy: (label: string, value: string) => void; copied: string | null; mono?: boolean }) {
	return (
		<div className="flex items-center gap-3">
			<span className="w-36 shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</span>
			<code className={`min-w-0 flex-1 truncate rounded-md bg-white px-2 py-1 text-sm ${mono ? "font-mono" : "font-sans"}`}>{value}</code>
			<Button type="button" variant="ghost" size="sm" onClick={() => onCopy(label, value)} aria-label={`Copy ${label}`}>
				<Copy className="h-4 w-4" />
				{copied === label ? "Copied" : "Copy"}
			</Button>
		</div>
	);
}
