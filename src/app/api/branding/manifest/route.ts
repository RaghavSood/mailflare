import { getCachedBranding } from "@/lib/branding/service";
import { buildWebAppManifest, MANIFEST_CONTENT_TYPE } from "@/lib/branding/install-utils";
import { getEnvAsync } from "@/lib/cloudflare";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The manifest v2 links when the install is custom-branded. Browsers fetch it
 * without cookies, and an installed app keeps re-fetching it, so it always
 * answers: without a license it is the static manifest again.
 */
export async function GET() {
	const env = await getEnvAsync();
	return new Response(JSON.stringify(buildWebAppManifest(await getCachedBranding(env))), {
		headers: {
			"Content-Type": MANIFEST_CONTENT_TYPE,
			"Cache-Control": "no-cache",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
