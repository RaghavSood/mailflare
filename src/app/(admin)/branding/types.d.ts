import type { InstallIconVariant } from "@/lib/branding/types";

export type BrandingFormResponse = {
	appName?: string;
	hasCustomIcon?: boolean;
	error?: string;
};

/** The resized install icons rendered in the browser, keyed by form field. */
export type InstallIconBlobs = Partial<Record<InstallIconVariant["field"], Blob>>;
