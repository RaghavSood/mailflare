export type Branding = {
	appName: string;
	hasCustomIcon: boolean;
	canCustomizeBranding: boolean;
	/** Changes whenever the branding is saved; null without a license. Used as `?v=` on icon and manifest URLs. */
	version: string | null;
};

/**
 * One install icon size. `fit` says how the admin page draws it: `contain`
 * keeps transparency, `safe-zone` fits the image inside the maskable 80%
 * circle on an opaque background, `opaque` fills the background because iOS
 * composites a transparent apple-touch-icon on black.
 */
export type InstallIconVariant = {
	id: "192" | "512" | "maskable-512" | "apple-touch";
	field: "icon192" | "icon512" | "iconMaskable512" | "appleTouchIcon";
	size: number;
	purpose: "any" | "maskable" | "apple";
	fit: "contain" | "safe-zone" | "opaque";
	staticPath: string;
};

export type WebAppManifest = {
	id: string;
	name: string;
	short_name: string;
	description: string;
	start_url: string;
	scope: string;
	display: "standalone";
	orientation: "any";
	background_color: string;
	theme_color: string;
	icons: { src: string; sizes: string; type: "image/png"; purpose: "any" | "maskable" }[];
};

export type BrandingHead = {
	appName: string;
	manifest: string;
	appleTouchIcon: string;
	favicon: string;
	/** The custom icon for the in-app brand mark, when there is one. */
	brandIcon: string | null;
};

/** A rectangle on a square canvas, in pixels. */
export type IconDrawRect = { x: number; y: number; width: number; height: number };

/** Resized install icons uploaded alongside a new icon, keyed by form field. */
export type InstallIconUploads = Partial<Record<InstallIconVariant["field"], File>>;
