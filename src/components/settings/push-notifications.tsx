"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PushControlState } from "./push-notifications-types";
import {
	base64UrlToBytes,
	bytesToBase64Url,
	getActivePushRegistration,
	loadPushKey,
	postPushSubscription,
	readPushEnvironment,
	resolvePushControlState,
} from "./push-notifications-utils";

const DESCRIPTIONS: Record<PushControlState, string> = {
	loading: "Checking this device...",
	unavailable: "Push notifications are not configured on this server. An administrator can turn them on.",
	unsupported: "This browser cannot show push notifications.",
	install: "On iPhone and iPad, notifications work only from the installed app. In Safari, tap Share, then Add to Home Screen, and turn them on from the app.",
	blocked: "Notifications are blocked for this site. Allow them in your browser's site settings, then come back here.",
	off: "Show a notification on this device when new mail arrives. Nothing is sent while Mailflare is open.",
	on: "New mail shows a notification on this device, with the sender and subject.",
	busy: "Updating...",
};

/**
 * Settings > Account card for new-mail notifications on this device. It
 * shares the /v2/ service worker and subscription with the v2 sidebar toggle.
 */
export function PushNotificationsSettings() {
	const [state, setState] = useState<PushControlState>("loading");
	const [publicKey, setPublicKey] = useState<string | null>(null);
	const [serviceWorker, setServiceWorker] = useState("");
	const [error, setError] = useState<string | null>(null);

	async function refresh(key: string | null) {
		setState(resolvePushControlState(await readPushEnvironment(key)));
	}

	useEffect(() => {
		loadPushKey()
			.then(async (response) => {
				setPublicKey(response.publicKey);
				setServiceWorker(response.serviceWorker);
				await refresh(response.publicKey);
			})
			.catch(() => setState("unavailable"));
	}, []);

	async function turnOn() {
		if (!publicKey) return;
		setError(null);
		setState("busy");
		try {
			const permission = await Notification.requestPermission();
			if (permission !== "granted") {
				await refresh(publicKey);
				return;
			}
			const registration = await getActivePushRegistration(serviceWorker);
			const existing = await registration.pushManager.getSubscription();
			const existingKey = existing?.options.applicationServerKey;
			if (existing && existingKey && bytesToBase64Url(existingKey) !== publicKey) await existing.unsubscribe();
			const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
			try {
				await postPushSubscription("/v2/push/subscribe", { ...subscription.toJSON(), applicationServerKey: publicKey });
			} catch (subscribeError) {
				await subscription.unsubscribe().catch(() => false);
				throw subscribeError;
			}
			setState("on");
		} catch (turnOnError) {
			setError(turnOnError instanceof Error ? turnOnError.message : "Could not turn on notifications");
			await refresh(publicKey);
		}
	}

	async function turnOff() {
		setError(null);
		setState("busy");
		try {
			const registration = await navigator.serviceWorker.getRegistration("/v2/");
			const subscription = await registration?.pushManager.getSubscription();
			if (subscription) {
				await postPushSubscription("/v2/push/unsubscribe", { endpoint: subscription.endpoint });
				await subscription.unsubscribe();
			}
			setState("off");
		} catch (turnOffError) {
			setError(turnOffError instanceof Error ? turnOffError.message : "Could not turn off notifications");
			await refresh(publicKey);
		}
	}

	return (
		<div className="space-y-4" data-push-settings={state}>
			<div className="flex items-start gap-3 rounded-2xl bg-neutral-50 p-4">
				{state === "on" ? (
					<Bell className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
				) : (
					<BellOff className="mt-0.5 h-5 w-5 shrink-0 text-neutral-400" />
				)}
				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium text-neutral-900">
						{state === "on" ? "Notifications are on for this device" : state === "install" ? "Install the app first" : state === "blocked" ? "Notifications are blocked" : "Notifications are off for this device"}
					</p>
					<p className="mt-1 text-sm text-neutral-500">{DESCRIPTIONS[state]}</p>
				</div>
			</div>
			{(state === "off" || state === "on" || state === "busy") && (
				<div className="flex flex-wrap gap-3">
					{state === "on" ? (
						<Button variant="outline" onClick={turnOff}>Turn off</Button>
					) : (
						<Button onClick={turnOn} disabled={state === "busy"}>Turn on notifications</Button>
					)}
				</div>
			)}
			{error && <p className="text-sm text-red-600">{error}</p>}
		</div>
	);
}
