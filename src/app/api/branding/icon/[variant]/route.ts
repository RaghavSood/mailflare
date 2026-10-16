import { getCachedBranding } from "@/lib/branding/service";
import { findInstallIconVariant, installIconCacheControl, installIconObjectKey } from "@/lib/branding/install-utils";
import { getEnvAsync } from "@/lib/cloudflare";
import type { InstallIconRouteParams } from "./types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * One install icon (192, 512, maskable-512, apple-touch). Always an image of
 * the declared size: the uploaded copy when licensed, otherwise the packaged
 * file it replaces, so a lapsed license or an icon saved before install icons
 * existed never breaks an installed app.
 */
export async function GET(request: Request, { params }: InstallIconRouteParams) {
	const variant = findInstallIconVariant((await params).variant);
	if (!variant) return new Response("Not found", { status: 404 });
	const env = await getEnvAsync();
	const url = new URL(request.url);
	const headers = {
		"Content-Type": "image/png",
		"Cache-Control": installIconCacheControl(url),
		"X-Content-Type-Options": "nosniff",
	};

	const branding = await getCachedBranding(env);
	if (branding.canCustomizeBranding && branding.hasCustomIcon) {
		try {
			const object = await env.BUCKET.get(installIconObjectKey(variant));
			if (object) return new Response(object.body, { headers });
		} catch {
			// Fall back to the packaged icon.
		}
	}
	const staticUrl = new URL(variant.staticPath, url.origin);
	let asset = await env.ASSETS.fetch(staticUrl).catch(() => null);
	// next dev has no ASSETS directory: Next serves public/ itself there. (A
	// redirect would inherit the app CSP's upgrade-insecure-requests.)
	if (!asset?.ok) asset = await fetch(staticUrl);
	if (!asset.ok) return new Response("Not found", { status: 404 });
	return new Response(asset.body, { headers: { ...headers, "Cache-Control": "no-cache" } });
}
