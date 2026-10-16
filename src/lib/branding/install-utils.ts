import type { Branding, BrandingHead, InstallIconVariant, WebAppManifest } from "./types";

export const DEFAULT_APP_NAME = "Mailflare";
export const STATIC_MANIFEST_URL = "/manifest.webmanifest";
export const BRANDED_MANIFEST_URL = "/api/branding/manifest";
export const MANIFEST_CONTENT_TYPE = "application/manifest+json";
const IMMUTABLE = "public, max-age=31536000, immutable";

/** What an unlicensed installation shows: the static manifest and icons. */
export const PACKAGED_BRANDING: Branding = {
	appName: DEFAULT_APP_NAME,
	hasCustomIcon: false,
	canCustomizeBranding: false,
	version: null,
};

/**
 * The install icons, each with the static file that stands in for it without
 * a license or before an admin has uploaded the resized copies. The admin
 * branding page renders every variant in the browser (Workers cannot resize
 * images), and the API refuses a PNG whose header disagrees with `size`.
 */
export const INSTALL_ICON_VARIANTS: readonly InstallIconVariant[] = [
	{ id: "192", field: "icon192", size: 192, purpose: "any", fit: "contain", staticPath: "/icon-192.png" },
	{ id: "512", field: "icon512", size: 512, purpose: "any", fit: "contain", staticPath: "/icon-512.png" },
	{ id: "maskable-512", field: "iconMaskable512", size: 512, purpose: "maskable", fit: "safe-zone", staticPath: "/icon-maskable-512.png" },
	{ id: "apple-touch", field: "appleTouchIcon", size: 180, purpose: "apple", fit: "opaque", staticPath: "/apple-touch-icon.png" },
];

export function findInstallIconVariant(id: string): InstallIconVariant | null {
	return INSTALL_ICON_VARIANTS.find((variant) => variant.id === id) ?? null;
}

export function installIconObjectKey(variant: InstallIconVariant): string {
	return `branding/app-icon-${variant.id}.png`;
}

/** A version for cache-busting URLs: the settings row's last update, in seconds. */
export function brandingVersion(updatedAt: Date | number | null | undefined): string | null {
	if (updatedAt === null || updatedAt === undefined) return null;
	const time = updatedAt instanceof Date ? updatedAt.getTime() : updatedAt;
	return Number.isFinite(time) ? String(Math.floor(time / 1000)) : null;
}

/** Whether the install differs from the static files at all. Unlicensed installs never do. */
export function hasCustomInstallBranding(branding: Branding): boolean {
	return branding.canCustomizeBranding && (branding.appName !== DEFAULT_APP_NAME || branding.hasCustomIcon);
}

function withVersion(path: string, version: string | null): string {
	return version ? `${path}?v=${encodeURIComponent(version)}` : path;
}

/** Where one install icon is fetched from: the branding route when there is a custom icon, else the static file. */
export function installIconUrl(branding: Branding, variant: InstallIconVariant): string {
	if (!branding.canCustomizeBranding || !branding.hasCustomIcon) return variant.staticPath;
	return withVersion(`/api/branding/icon/${variant.id}`, branding.version);
}

function variantById(id: InstallIconVariant["id"]): InstallIconVariant {
	const variant = findInstallIconVariant(id);
	if (!variant) throw new Error(`Unknown install icon ${id}`);
	return variant;
}

/**
 * The web app manifest. Without custom branding this is exactly
 * public/manifest.webmanifest; with it only the name and icons change, so `id`
 * keeps it the same installed app.
 */
export function buildWebAppManifest(branding: Branding): WebAppManifest {
	const custom = hasCustomInstallBranding(branding);
	const name = custom ? branding.appName : DEFAULT_APP_NAME;
	const icon = (id: InstallIconVariant["id"]) => (custom ? installIconUrl(branding, variantById(id)) : variantById(id).staticPath);
	return {
		id: "/v2/",
		name,
		short_name: name,
		description: "Email on your own Cloudflare account.",
		start_url: "/v2/inbox",
		scope: "/v2/",
		display: "standalone",
		orientation: "any",
		background_color: "#ffffff",
		theme_color: "#ffffff",
		icons: [
			{ src: icon("192"), sizes: "192x192", type: "image/png", purpose: "any" },
			{ src: icon("512"), sizes: "512x512", type: "image/png", purpose: "any" },
			{ src: icon("maskable-512"), sizes: "512x512", type: "image/png", purpose: "maskable" },
		],
	};
}

/** The <head> links a v2 page points at: the static files unless the install is custom-branded. */
export function brandingHead(branding: Branding): BrandingHead {
	if (!hasCustomInstallBranding(branding)) {
		return { appName: DEFAULT_APP_NAME, manifest: STATIC_MANIFEST_URL, appleTouchIcon: "/apple-touch-icon.png", favicon: "/favicon.ico", brandIcon: null };
	}
	const icon = branding.hasCustomIcon ? installIconUrl(branding, variantById("192")) : null;
	return {
		appName: branding.appName,
		manifest: withVersion(BRANDED_MANIFEST_URL, branding.version),
		appleTouchIcon: installIconUrl(branding, variantById("apple-touch")),
		favicon: icon ?? "/favicon.ico",
		brandIcon: icon,
	};
}

/** The icon a push notification shows, or null to keep the service worker's default. */
export function pushNotificationIcon(branding: Branding): string | null {
	return branding.canCustomizeBranding && branding.hasCustomIcon ? installIconUrl(branding, variantById("192")) : null;
}

/** Versioned icon URLs never change content, so browsers may keep them; unversioned ones revalidate. */
export function installIconCacheControl(url: URL): string {
	return url.searchParams.get("v") ? IMMUTABLE : "no-cache";
}
