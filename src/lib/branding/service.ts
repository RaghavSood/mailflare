import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import type { Branding, InstallIconUploads } from "./types";
import { brandingVersion, DEFAULT_APP_NAME, INSTALL_ICON_VARIANTS, installIconObjectKey } from "./install-utils";
import { getLicenseEntitlements } from "@/lib/licenses/service";

export { DEFAULT_APP_NAME } from "./install-utils";
export const APP_SETTINGS_ID = "default";
export const BRANDING_ICON_KEY = "branding/app-icon";

export async function getBranding(env: Pick<CloudflareEnv, "DB">): Promise<Branding> {
	const entitlements = await getLicenseEntitlements(env);
	if (!entitlements.canCustomizeBranding) {
		return { appName: DEFAULT_APP_NAME, hasCustomIcon: false, canCustomizeBranding: false, version: null };
	}

	try {
		const [settings] = await getDb(env)
			.select()
			.from(appSettings)
			.where(eq(appSettings.id, APP_SETTINGS_ID))
			.limit(1);
		return {
			appName: settings?.appName || DEFAULT_APP_NAME,
			hasCustomIcon: !!settings?.iconKey,
			canCustomizeBranding: true,
			version: brandingVersion(settings?.updatedAt),
		};
	} catch {
		return { appName: DEFAULT_APP_NAME, hasCustomIcon: false, canCustomizeBranding: true, version: null };
	}
}

/**
 * Branding for every v2 page and push notice. Reading it checks the license
 * (an upsert) and the settings row, so each isolate keeps it a few seconds; a
 * save clears this isolate's copy and other isolates catch up within the TTL.
 */
const BRANDING_TTL_MS = 15_000;
let brandingCache: { value: Branding; expires: number } | null = null;

export async function getCachedBranding(env: Pick<CloudflareEnv, "DB">): Promise<Branding> {
	const now = Date.now();
	if (brandingCache && brandingCache.expires > now) return brandingCache.value;
	const value = await getBranding(env);
	brandingCache = { value, expires: now + BRANDING_TTL_MS };
	return value;
}

export async function updateBranding(
	env: CloudflareEnv,
	input: { appName: string; icon?: File | null; installIcons?: InstallIconUploads | null },
): Promise<Branding> {
	if (!(await getLicenseEntitlements(env)).canCustomizeBranding) {
		throw new Error("A Pro or Team license is required to customize branding");
	}
	let iconKey: string | undefined;
	if (input.icon) {
		iconKey = BRANDING_ICON_KEY;
		await env.BUCKET.put(iconKey, await input.icon.arrayBuffer(), {
			httpMetadata: { contentType: input.icon.type },
		});
		// The install icons are written before the settings row moves the version
		// on, so no page links a version whose files are not there yet. A new icon
		// without them (an API client) drops the old ones: the install then uses
		// the packaged icons rather than the previous custom one.
		const installIcons = input.installIcons;
		for (const variant of INSTALL_ICON_VARIANTS) {
			const file = installIcons?.[variant.field];
			if (file) {
				await env.BUCKET.put(installIconObjectKey(variant), await file.arrayBuffer(), {
					httpMetadata: { contentType: "image/png" },
				});
			} else {
				await env.BUCKET.delete(installIconObjectKey(variant));
			}
		}
	}

	await getDb(env)
		.insert(appSettings)
		.values({
			id: APP_SETTINGS_ID,
			appName: input.appName,
			iconKey: iconKey ?? null,
		})
		.onConflictDoUpdate({
			target: appSettings.id,
			set: {
				appName: input.appName,
				...(iconKey ? { iconKey } : {}),
				updatedAt: new Date(),
			},
		});
	brandingCache = null;
	return getBranding(env);
}
