# Android journeys

Natural-language end-to-end tests of the mobile web app (v2 as a PWA, plus the classic pages on a phone), in the [Android CLI journey format](https://developer.android.com/tools/agents/android-cli/journeys). Each `*.journey.xml` is a list of `<action>`s. An agent works through them on a real device or emulator, using `android layout` / `android screen` to look and `adb shell input` to act. An action starting with "Verify" is an assertion. The XML is the source of truth: if the app disagrees with a journey, the app fails.

| Journey | Covers |
|---|---|
| `01-sign-in-lands-in-v2` | Signed-out `/v2/inbox` → sign in → back on `/v2/inbox` (`mf_ui`), phone layout |
| `02-install-and-launch-as-app` | Chrome install prompt, home-screen icon, standalone launch (manifest, icons) |
| `03-navigation-drawer` | Drawer folders, no keyboard-shortcut entry on touch, Back closes the drawer |
| `04-read-conversation-and-sheets` | Conversation view, details and ⋮ bottom sheets, Back closes a sheet |
| `05-swipe-to-trash-undo-and-archive` | Row swipes, Undo, Archive |
| `06-pull-to-refresh` | In-app pull to refresh, no full reload |
| `07-compose-and-send` | Composer with the on-screen keyboard, contact suggestion chips, send |
| `08-read-offline` | Offline banner, cached list and conversation, recovery after reconnect |
| `09-queue-actions-offline` | Outbox: action queued offline, replayed on reconnect |
| `10-push-notifications-opt-in` | Notification permission, subscribe and unsubscribe |
| `11-classic-interface-on-a-phone` | Classic list, reader, drawer, settings tab strip, switching back to v2 |
| `12-sign-out-clears-offline-copies` | Sign-out clears the per-user cache and outbox |

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

## Running journeys

Ask an agent that has the Android CLI skills to "run `journeys/05-swipe-to-trash-undo-and-archive.journey.xml` on emulator-5554". It follows the journey reference (each action exactly as written, Verify actions inspect without interacting) and writes a Markdown result with ✅/❌ per action.

Things that tripped the first run:

- **Offline on an emulator.** Airplane mode does not cut `adb reverse`; the tunnel runs over the adb transport, not the device network. When a journey turns Airplane mode on, also run `adb reverse --remove tcp:3000`, and run `adb reverse tcp:3000 tcp:3000` again when it turns it off. Check with a fetch from the page if in doubt: an earlier kept-alive connection can still get through.
- **The page is a WebView to `android layout`.** v2 page content often does not appear in the layout dump. Use `android screen capture --annotate` and the screenshot, as the interaction reference says for WebViews.
- **Quick Settings.** Wait for Quick Settings to finish opening before tapping the Airplane mode tile; an early tap lands on the page behind it.
- **Typing URLs.** `adb shell input text` can drop characters in Chrome's address bar and turn the URL into a search. A VIEW intent (`am start -a android.intent.action.VIEW -d <url>`) is the same navigation without the keyboard.
- **Installing on localhost.** Chrome cannot mint a WebAPK for `http://localhost`, so journey 02 installs a Chrome-hosted web app (icon with a small Chrome badge). It still launches standalone.

Push delivery is not a journey, because it needs mail sent from outside the device. To check it by hand: turn notifications on (journey 10), leave the app (no open v2 page means no realtime socket, so the server does not suppress the push), deliver a message with the `curl` above, then tap the notification. It should open that conversation. With the app open in the foreground, the same delivery refreshes the list and posts no notification.

## Last run

2026-10-14, `main` at f251789, Android 16 emulator, Chrome 133:

| Journey | Result |
|---|---|
| 01 | ✅ |
| 02 | ✅ |
| 03 | ❌ Back with the drawer open navigates away (pre-existing; same before #12–#18) |
| 04 | ❌ Back with a bottom sheet open leaves the conversation (#19) |
| 05 | ✅ |
| 06 | ✅ |
| 07 | ✅ |
| 08 | ❌ A cached conversation is never refreshed after reconnecting (#20) |
| 09 | ✅ |
| 10 | ✅ |
| 11 | ✅ |
| 12 | ✅ |

Push delivery (by hand): ✅ delivered with the app closed, ✅ suppressed with it open, ✅ notification opens the conversation.
