import { after } from "next/server";

/**
 * Run work the response does not depend on (audit rows, spam training) after
 * it is sent. Outside a request, where Next has nowhere to attach it, the work
 * runs immediately instead.
 */
export function runAfterResponse(label: string, task: () => Promise<unknown>): void {
	const guarded = async () => {
		try {
			await task();
		} catch (error) {
			console.error(`${label} failed after response`, error);
		}
	};
	try {
		after(guarded);
	} catch {
		void guarded();
	}
}
