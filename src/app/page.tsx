import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getUserFromSession, SESSION_COOKIE } from "@/lib/auth/session";
import { getEnv } from "@/lib/cloudflare";
import { homePathFor, UI_PREFERENCE_COOKIE } from "@/lib/v2/preference";
import { LandingPage } from "./landing-page";

export const dynamic = "force-dynamic";

/** Someone signed in (an installed app or home-screen shortcut opening "/") goes straight to the interface they last used. */
export default async function HomePage() {
	const cookieStore = await cookies();
	const homePath = homePathFor(cookieStore.get(UI_PREFERENCE_COOKIE)?.value);
	const token = cookieStore.get(SESSION_COOKIE)?.value;
	if (token) {
		// Before setup there is no sessions table; the landing page is still the right answer.
		const user = await getUserFromSession(getEnv(), token).catch(() => null);
		if (user && !user.disabled) redirect(homePath);
	}
	return <LandingPage homePath={homePath} />;
}
