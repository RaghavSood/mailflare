import { expect } from "./harness.mjs";

const journey = {
	setup: ({ device }) => device.startSignedIn(),
	steps: [
		[
			"Swipe slowly downwards starting on the first conversation row, ending near the middle of the screen",
			async ({ device }) => {
				// Watch (without touching anything) for the refresh indicator and for the list being swapped,
				// and mark this document so a full reload would show.
				await device.eval(() => {
					const list = document.querySelector("#list-form");
					window.__jPtr = { document: true, indicator: false, list };
					new MutationObserver(() => {
						if (document.querySelector(".ptr.is-refreshing, .ptr.is-armed")) window.__jPtr.indicator = true;
					}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], childList: true });
				});
				const { page, box } = await device.locate("li[data-row]");
				const from = await device.toScreen(page, box.x, box.y);
				await device.swipeScreen(from.x, from.y, from.x, device.height * 0.55, 1200);
			},
		],
		[
			"Verify that a refresh indicator appears at the top of the list, or that the list has refreshed",
			({ device }) =>
				device.until(() => window.__jPtr && (window.__jPtr.indicator || (!window.__jPtr.list.isConnected && document.querySelector("#list-form"))), null, { message: "a refresh indicator or a refreshed list" }),
		],
		[
			'Verify that the inbox is still shown with the "Inbox" heading and the message list, and that no sign-in page or browser error page is shown',
			async ({ device }) => {
				const state = await device.until(() => {
					const rows = [...document.querySelectorAll("li[data-row]")].filter(window.__j.shown).length;
					return document.querySelector(".ptr.is-refreshing") ? null : { path: location.pathname, sameDocument: !!window.__jPtr?.document, heading: !!window.__j.byText(".tb-title", "Inbox"), rows };
				}, null, { message: "the refresh to finish" });
				expect(state.sameDocument, "the page was reloaded in full");
				expect(state.path === "/v2/inbox" && state.heading && state.rows > 0, `the inbox is not shown (${JSON.stringify(state)})`);
			},
		],
	],
};

export default journey;
