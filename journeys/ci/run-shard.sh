#!/usr/bin/env bash
# Runs inside android-emulator-runner (one command, since its `script` runs each line separately):
# waits for journeys/ci/server.sh, prints what device CI got, then runs one shard of the journeys.
set -uo pipefail
SHARD="${1:?usage: run-shard.sh k/n [runner flags]}"
shift
OUT="${OUT:-journey-results}"
t0=$SECONDS
until [ -f "$OUT/server.ready" ] || [ -f "$OUT/server.failed" ]; do
	if [ $((SECONDS - t0)) -gt 600 ]; then echo "server did not start"; exit 1; fi
	sleep 2
done
echo "waited $((SECONDS - t0))s for the server"
if [ -f "$OUT/server.failed" ]; then
	echo "server setup failed"; tail -50 "$OUT/server.log" "$OUT/build.log" "$OUT/wrangler.log" 2>/dev/null; exit 1
fi
adb shell getprop ro.build.version.sdk
adb shell dumpsys package com.android.chrome 2>/dev/null | grep -m1 versionName
adb shell wm size
adb shell wm density
# Hard stop well inside the job's timeout, so the summary and artifacts still get published.
timeout -k 10 900 node journeys/run/index.mjs --shard "$SHARD" --out "$OUT" "$@"
status=$?
[ $status -eq 124 ] && echo "the journey runner did not finish within 15 minutes"
exit $status
