# Android journeys

Natural-language end-to-end tests of the mobile web app (v2 as a PWA, plus the classic pages on a phone), in the [Android CLI journey format](https://developer.android.com/tools/agents/android-cli/journeys). Each `*.journey.xml` is a list of `<action>`s. An agent works through them on a real device or emulator, using `android layout` / `android screen` to look and `adb shell input` to act. An action starting with "Verify" is an assertion. The XML is the source of truth: if the app disagrees with a journey, the app fails.

| Journey | Covers |
|---|---|
| `01-sign-in-lands-in-v2` | Signed-out `/v2/inbox` → sign in → back on `/v2/inbox` (`mf_ui`), phone layout |
| `02-install-and-launch-as-app` | Chrome install prompt, home-screen icon, standalone launch (manifest, icons) |
| `03-navigation-drawer` | Drawer folders, no keyboard-shortcut entry on touch, Back closes the drawer and leaves no extra history entry |
| `04-read-conversation-and-sheets` | Conversation view, details and ⋮ bottom sheets, Back closes either sheet and then leaves the conversation |
| `05-swipe-to-trash-undo-and-archive` | Row swipes, Undo, Archive |
| `06-pull-to-refresh` | In-app pull to refresh, no full reload |
| `07-compose-and-send` | Composer with the on-screen keyboard, Send with no recipient returns the keyboard to the To chips, contact suggestion chips, send |
| `08-read-offline` | Offline banner, cached list and conversation, recovery after reconnect |
| `09-queue-actions-offline` | Outbox: action queued offline, replayed on reconnect |
| `10-push-notifications-opt-in` | Notification permission, subscribe and unsubscribe |
| `11-classic-interface-on-a-phone` | Classic list, reader, drawer, settings tab strip, switching back to v2 |
| `12-sign-out-clears-offline-copies` | Sign-out clears the per-user cache and outbox |
| `13-compose-offline-sends-once` | Composer from the offline cache (stored ahead by the warm-up, never opened online), send queued, delivered exactly once on reconnect with no draft left |
| `14-saved-copy-recovers-when-the-server-returns` | Server out of reach while the device is online: saved copy, "Couldn't reach Mailflare", recovery |
| `15-discard-offline-draft` | Drafts discarded offline (one only on the device, one the server had) stay gone on reconnect |
| `16-act-inside-a-conversation` | Toolbar Move → Archive, Star and Snooze → Next week from inside a conversation, each checked in its view; Move → Archive queued offline and applied on reconnect |
| `17-tablet-thread-actions` | Tablet band (the phone set to 1280×800 at density 200 for the journey, reset in teardown): a conversation opens beside its list, and its ⋮ dropdown and details respond to a tap made as quickly as adb allows after opening it (#31) |
| `18-send-from-a-draft` | A draft opened from Drafts and sent: the address moves to the Drafts list, pull to refresh shows that list (not "Not found"), the message is in Sent |
| `19-refused-list-action` | A list action the server refuses (Archive on a conversation moved to Trash meanwhile, picked by tapping its avatar): the list reloads and the server's reason stays shown (#38) |
| `20-replay-after-a-slow-reconnect` | Outbox: Airplane mode turned off while the server is not reachable yet (the runner's relay keeps refusing it), the first replay fails, the page retries with backoff and the action lands once the server answers, with no reload (#42) |
| `23-undo-survives-new-mail` | New mail arriving over the realtime connection (delivered by the runner while the inbox is on screen) reloads the list in place and keeps the "Conversation archived." message with its Undo; Undo brings the conversation back (#48) |
| `24-discard-offline-reply` | A reply the server has saved, discarded offline: the reply closes, its buttons come back and "Draft discarded." stays (the reload that closing it starts fails offline and must say nothing, #44); the discard replays on reconnect |

Each journey's `<description>` states the starting state. Journeys start with the app already in the foreground; none of them launches it.

## Set up a device

```sh
android sdk install platform-tools emulator
android emulator create medium_phone          # Google Play image, includes Chrome
android emulator start medium_phone
export PATH="$HOME/Library/Android/sdk/platform-tools:$PATH"
android init                                  # installs the Android CLI agent skills, including journeys
```

Chrome on the device:

```sh
# Skip Chrome's first-run screens.
adb shell am set-debug-app --persistent com.android.chrome
adb shell 'echo "chrome --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line'
# Let Chrome post notifications at the OS level (journey 10 still asks per site).
adb shell pm grant com.android.chrome android.permission.POST_NOTIFICATIONS
```

Turn off Chrome's "Offer to save passwords" (Settings → Password Manager). Otherwise its bubble covers the top of the page after journey 01 signs in.

## Run the server

Use a real Worker build, because service-worker behaviour differs under `next dev`:

```sh
npm run db:migrate:local
node scripts/generate-vapid-keys.mjs > .dev.vars          # push keys, local only
npx next dev -p 3000 &                                     # only to seed
curl -X POST localhost:3000/api/seed
npx wrangler d1 execute DB --local --command "update users set role='admin' where email='admin@example.com'"
kill %1
npm run build && npx wrangler dev --port 3000
```

The seeded login is `admin@example.com` / `demo-password-change-me`. The seed user is not an admin until the update above; without it `/login` redirects to `/setup`.

Point the device's `localhost:3000` at the host. `localhost` is a secure context, so the service worker, install and push all work over plain HTTP:

```sh
adb reverse tcp:3000 tcp:3000
adb shell am start -a android.intent.action.VIEW -d http://localhost:3000/v2/inbox com.android.chrome
```

Deliver test mail through the Worker's own `email` handler. This exercises the inbound queue, realtime updates and push:

```sh
printf 'From: QA <qa@qa.test>\r\nTo: support@example.com\r\nSubject: Hello\r\nMessage-ID: <%s@qa.test>\r\nDate: %s\r\n\r\nBody\r\n' "$(date +%s%N)" "$(date -R)" > /tmp/m.eml
curl -X POST "http://localhost:3000/cdn-cgi/handler/email?from=qa@qa.test&to=support@example.com" --data-binary @/tmp/m.eml
```

## Running the scripted journeys

Each journey has a deterministic script, `journeys/run/<same id>.mjs`, that performs every `<action>` in order as one step labelled with the action's text. The runner refuses a script whose steps drift from the XML, so the XML stays the source of truth: change a journey, then change its script. CI runs the scripts on every pull request and on `main` (`.github/workflows/ci.yml`).

With the server and a device set up as above:

```sh
export ANDROID_SERIAL=emulator-5554      # which device, when more than one is attached
export MAILFLARE_HOST_PORT=3000          # the host port the server listens on (the runner relays the device's localhost:3000 to it)
export CDP_PORT=9222                     # host port for Chrome DevTools
node journeys/run/index.mjs              # all journeys; or name some: node journeys/run/index.mjs 05 08
node journeys/run/index.mjs --shard 2/3  # one CI shard
```

It writes `journey-results/summary.md` (✅/❌ per action, in the shape of the table below), `journey-results/junit.xml`, and a screenshot of the screen for each failure, and exits non-zero if any journey fails. A journey without a script fails the run too, unless `--allow-unscripted` is given (CI passes it only on draft pull requests). Journeys whose failure is an open issue name it (`knownIssue` in the script); the label is shown next to the failure and never turns it into a pass.

How the scripts work:

- **Input is real device input.** Taps and swipes are `adb shell input`, Back is the Back key, typing goes through the on-screen keyboard with `input text`. Chrome DevTools (the forwarded `chrome_devtools_remote` socket) is only used to wait, assert, and find where an element is on screen; a first tap, swallowed in the page before the app sees it, maps page pixels to screen pixels. Taps wait for the element to be on screen, enabled, uncovered and still, check where the touch landed, and are retried once when the expected effect (focus, drawer, navigation) does not follow. A busy page can take a touch, or show what it did, after the wait for it gave up, and a second touch then lands on what the first one opened (the drawer's scrim, its mailbox picker, the next row of a list), so every retry first gives the effect a little longer and looks for the first touch arriving late (`tap`, `retryUnlessDone` in `harness.mjs`); calibration taps are swallowed until each one sent has arrived. Typing is checked and redone once if `input text` dropped a character.
- **Each journey sets up its own start state** from its `<description>` (signed in through the API, enough mail delivered, the service worker controlling the page), so shards and single journeys run independently. The runner clears Chrome's data on the device first (`pm clear`), so it starts with one tab and notifications at "Ask"; pass `--keep-chrome-data` to skip that on a device you also use by hand.
- **Offline** is Airplane mode plus cutting the server off. The runner reverses the device's `localhost:3000` to a small relay of its own in front of `MAILFLARE_HOST_PORT`; going offline closes every connection through it and refuses new ones, because removing the `adb reverse` tunnel leaves Chrome's kept-alive connections working. The step then checks from the page that the server cannot be reached. Quick Settings is opened with `cmd statusbar expand-settings` (two swipes from the status bar are not reliably produced by `input swipe`) and closed with `cmd statusbar collapse` (Back first collapses the panel to the shade, and a second Back can reach the page). Airplane mode itself is set with `cmd connectivity airplane-mode`, the setting the tile toggles, because the tile's place differs between images.
- **The display is the device's own.** Journey 17 makes the phone a 1280×800 screen and puts it back in teardown. A run cut off between the two (adb dropping, the runner killed) would leave every later journey on that screen, so the runner checks `wm size` and `wm density` at the start and before each journey, resets any override, and says so at the top of the summary.
- **Waits end early.** "Wait 10 seconds" and similar steps wait up to that long for what the next Verify checks, then move on.
- **Chrome's "Save password?" message** after journey 01 is swiped away in that journey's teardown, so it cannot cover the next journey's toolbar.

## Running journeys with an agent

For writing or debugging a journey, ask an agent that has the Android CLI skills to "run `journeys/05-swipe-to-trash-undo-and-archive.journey.xml` on emulator-5554". It follows the journey reference (each action exactly as written, Verify actions inspect without interacting) and writes a Markdown result with ✅/❌ per action.

Things that tripped the first run:

- **Offline on an emulator.** Airplane mode does not cut `adb reverse`; the tunnel runs over the adb transport, not the device network. When a journey turns Airplane mode on, also run `adb reverse --remove tcp:3000`, and run `adb reverse tcp:3000 tcp:3000` again when it turns it off. Check with a fetch from the page if in doubt: an earlier kept-alive connection can still get through. Cutting the server off without Airplane mode (journey 14) is how to make it unreachable while the browser still reports being online; the scripted run does that at its relay.
- **Closing Quick Settings.** A second Back press after Quick Settings has closed leaves Chrome, and closes a tab that a VIEW intent opened. `adb shell cmd statusbar collapse` closes it without that risk.
- **Edge swipes.** A swipe that starts at the very edge of the screen is Android's Back gesture. Start row swipes a little inside (for example x=1000 on a 1080-px-wide screen).
- **The page is a WebView to `android layout`.** v2 page content often does not appear in the layout dump. Use `android screen capture --annotate` and the screenshot, as the interaction reference says for WebViews.
- **Quick Settings.** Wait for Quick Settings to finish opening before tapping the Airplane mode tile; an early tap lands on the page behind it.
- **Typing URLs.** `adb shell input text` can drop characters in Chrome's address bar and turn the URL into a search. A VIEW intent (`am start -a android.intent.action.VIEW -d <url>`) is the same navigation without the keyboard.
- **Installing on localhost.** Chrome cannot mint a WebAPK for `http://localhost`, so journey 02 installs a Chrome-hosted web app (icon with a small Chrome badge). It still launches standalone. Being a pinned shortcut, not an app, it is never in the app drawer. The Pixel launcher only queues it when the pin is confirmed and places it the next time it comes to the front, on the first page with room: the second home screen page on the Android 16 image, since the first holds "At a glance". The script reads where from the launcher's log (`AddWorkspaceItemsTask … screen=<page>`), goes to that page checking that each swipe really moved, and keeps looking until a deadline.

Push delivery is not a journey, because it needs mail sent from outside the device. To check it by hand: turn notifications on (journey 10), leave the app (no open v2 page means no realtime socket, so the server does not suppress the push), deliver a message with the `curl` above, then tap the notification. It should open that conversation. With the app open in the foreground, the same delivery refreshes the list and posts no notification.

## Last run

2026-10-14, scripted (`node journeys/run/index.mjs`), branch `ci/journeys` on `main` at 1cce18b, Android 16 emulator, Chrome 133; three full runs in a row locally, and in CI on every pull request:

| Journey | Result |
|---|---|
| 01 | ✅ |
| 02 | ✅ |
| 03 | ⚠️ "Verify that the drawer is closed…" fails as expected: Back with the drawer open leaves the list (#19) |
| 04 | ⚠️ "Verify that the bottom panel is closed…" fails as expected: Back with a bottom sheet open leaves the conversation (#19) |
| 05 | ✅ |
| 06 | ✅ |
| 07 | ✅ |
| 08 | ✅ with the fix for #20 |
| 09 | ✅ |
| 10 | ✅ |
| 11 | ✅ |
| 12 | ✅ |
| 14 | ✅ (added with the fix for #20) |
| 16 | ✅ (added with the fix for #29) |

With the fix for #19 (this branch, scripted, Android 16 emulator, Chrome 133, built Worker): 03 ✅ and 04 ✅ with their new Back steps, 05 ✅, 11 ✅.

Push delivery (by hand, 2026-10-14 at f251789): ✅ delivered with the app closed, ✅ suppressed with it open, ✅ notification opens the conversation.
