import type { NextConfig } from "next";
import { getSecurityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
	turbopack: {
		root: import.meta.dirname,
	},
  allowedDevOrigins: ['mail.dev'],
	typescript: {
    // !! WARN !!
    // Dangerously allow production builds to successfully complete
    // even if your project has type errors.
    ignoreBuildErrors: true,
	  },
	// Native and server-only packages used by the self-hosted runtime; never bundle them.
	serverExternalPackages: ["better-sqlite3", "nodemailer", "smtp-server", "ws"],
	async headers() {
		return [
			{
				source: "/(.*)",
				headers: getSecurityHeaders(),
			},
			// Mirrors public/_headers for the self-hosted runtime, which serves
			// public/ through Next rather than Cloudflare assets.
			{
				source: "/sw.js",
				headers: [{ key: "Cache-Control", value: "no-cache" }],
			},
			{
				source: "/manifest.webmanifest",
				headers: [
					{ key: "Cache-Control", value: "no-cache" },
					{ key: "Content-Type", value: "application/manifest+json" },
				],
			},
		];
	},
};

export default nextConfig;

// Enable calling `getCloudflareContext()` in `next dev`. The self-hosted
// runtime provides its own env, so it skips this.
// See https://opennext.js.org/cloudflare/bindings#local-access-to-bindings.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
if (process.env.MAILFLARE_RUNTIME !== "node") initOpenNextCloudflareForDev();
