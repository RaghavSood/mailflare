import { getEnv } from "@/lib/cloudflare";
import { handleV2Request } from "@/lib/v2/handler";

async function handle(request: Request) {
	return handleV2Request(request, getEnv());
}

export const GET = handle;
export const POST = handle;
export const dynamic = "force-dynamic";
