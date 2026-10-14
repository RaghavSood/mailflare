import { brandingHead, PACKAGED_BRANDING } from "@/lib/branding/install-utils";
import type { BrandingHead } from "@/lib/branding/types";
import type { V2Context } from "../types";

/** The name, manifest and icons a page shows: licensed custom branding, else the packaged files. */
export function brandingHeadOf(ctx: Pick<V2Context, "branding">): BrandingHead {
	return brandingHead(ctx.branding ?? PACKAGED_BRANDING);
}

export function appNameOf(ctx: Pick<V2Context, "branding">): string {
	return brandingHeadOf(ctx).appName;
}
