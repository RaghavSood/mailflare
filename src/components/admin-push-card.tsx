"use client";

import { useEffect, useState } from "react";
import { BellRing, CheckCircle2, CircleX } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getPushStatus } from "./admin-push-card-utils";
import type { PushStatusResponse } from "./admin-push-card-types";

export function AdminPushCard() {
	const [status, setStatus] = useState<PushStatusResponse>();
	const [error, setError] = useState("");

	useEffect(() => {
		let isActive = true;
		getPushStatus()
			.then((pushStatus) => {
				if (isActive) setStatus(pushStatus);
			})
			.catch((statusError) => {
				if (isActive) setError(statusError instanceof Error ? statusError.message : "Could not check push notifications");
			});
		return () => {
			isActive = false;
		};
	}, []);

	return (
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="flex-row items-center gap-4 space-y-0 py-0">
				<div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-700">
					<BellRing className="h-5 w-5" />
				</div>
				<div>
					<CardTitle className="text-base">Push notifications</CardTitle>
					<p className="mt-1 text-sm text-neutral-500">
						New-mail notifications on devices that installed the app and turned them on.
					</p>
				</div>
			</CardHeader>
			<CardContent className="space-y-3 pt-5">
				{!status && !error && <Skeleton className="h-12 w-full rounded-2xl" />}
				{status && (
					<div className="divide-y divide-neutral-100 overflow-hidden rounded-2xl border border-neutral-100">
						<div className="flex items-center gap-3 px-4 py-4 text-sm">
							{status.configured ? (
								<CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
							) : (
								<CircleX className="h-4 w-4 shrink-0 text-red-600" />
							)}
							<p className="min-w-0 text-neutral-700">
								{status.configured ? "Configured." : "Not configured: users cannot turn notifications on."}
							</p>
							{status.subscriptions !== null && (
								<span className="ml-auto shrink-0 text-xs font-medium text-neutral-500">
									{status.subscriptions} {status.subscriptions === 1 ? "device" : "devices"}
								</span>
							)}
						</div>
						{!status.configured && (
							<div className="space-y-2 px-4 py-4 text-sm text-neutral-600">
								<ul className="list-disc space-y-1 pl-5">
									{status.problems.map((problem) => <li key={problem}>{problem}</li>)}
								</ul>
								<p>
									Generate a key pair with <code className="text-xs">node scripts/generate-vapid-keys.mjs</code> and set{" "}
									<code className="text-xs">VAPID_PUBLIC_KEY</code>, <code className="text-xs">VAPID_PRIVATE_KEY</code> and{" "}
									<code className="text-xs">VAPID_SUBJECT</code> as Worker secrets (or environment variables when self-hosted).
								</p>
							</div>
						)}
					</div>
				)}
				{error && <p className="text-sm text-red-600">{error}</p>}
			</CardContent>
		</Card>
	);
}
