#!/usr/bin/env bash
# Prepares and starts the server the journeys run against: a migrated and seeded local D1, then the
# real Worker build under `wrangler dev`. CI runs this in the background while the emulator boots and
# waits for journey-results/server.ready (or server.failed). Same steps as journeys/README.md.
set -euo pipefail
PORT="${PORT:-3000}"
OUT="${OUT:-journey-results}"
mkdir -p "$OUT"
rm -f "$OUT/server.ready" "$OUT/server.failed"
trap 'touch "$OUT/server.failed"' ERR
t0=$SECONDS
stamp() { echo "[server +$((SECONDS - t0))s] $*"; }

npm run db:bundle
npx wrangler d1 migrations apply DB --local
[ -f .dev.vars ] || node scripts/generate-vapid-keys.mjs > .dev.vars
stamp "migrated"

# /api/seed answers only outside production, so seeding needs next dev.
npx next dev -p "$PORT" > "$OUT/next-dev.log" 2>&1 &
dev=$!
for _ in $(seq 1 180); do
	if curl -sf -X POST "http://127.0.0.1:$PORT/api/seed" -o "$OUT/seed.json"; then break; fi
	sleep 1
done
kill "$dev" 2>/dev/null || true
pkill -f "next dev -p $PORT" 2>/dev/null || true
wait "$dev" 2>/dev/null || true
grep -q '"ok":true' "$OUT/seed.json"
npx wrangler d1 execute DB --local --command "update users set role='admin' where email='admin@example.com'" > /dev/null
stamp "seeded"

npm run build > "$OUT/build.log" 2>&1
stamp "built"

# wrangler dev has been seen on CI to print an empty "[ERROR]" and stop answering without exiting.
# Restart it when it exits, and kill it when /login fails three checks in a row, rather than failing
# every journey after it. Each restart is logged to wrangler-restarts.log and shown in the job summary.
# Both loops turn off errexit/pipefail inherited from above: a killed wrangler dev exits non-zero, and
# that must lead to a restart, not end the loop.
(
	set +eo pipefail
	trap - ERR
	while true; do
		WRANGLER_LOG=debug npx wrangler dev --port "$PORT" --ip 127.0.0.1 >> "$OUT/wrangler.log" 2>&1
		echo "$(date -u +%H:%M:%S) wrangler dev exited with $?; restarting" | tee -a "$OUT/wrangler-restarts.log"
		sleep 1
	done
) &
(
	set +eo pipefail
	trap - ERR
	until [ -f "$OUT/server.ready" ]; do sleep 2; done
	misses=0
	while true; do
		if curl -sf --max-time 5 "http://127.0.0.1:$PORT/login" -o /dev/null; then
			misses=0
		else
			misses=$((misses + 1))
			if [ "$misses" -ge 3 ]; then
				echo "$(date -u +%H:%M:%S) wrangler dev stopped answering /login; killing it" | tee -a "$OUT/wrangler-restarts.log"
				{ free -m; sudo dmesg 2>/dev/null | grep -iE "oom|killed process|segfault" | tail -5; } >> "$OUT/wrangler-restarts.log" 2>&1
				cp ~/.config/.wrangler/logs/*.log "$OUT/" 2>/dev/null || true
				pkill -f "wrangler dev --port $PORT" || true
				pkill -f workerd || true
				misses=0
				# Let the restart loop bring it back before watching again.
				t=0
				until curl -sf --max-time 5 "http://127.0.0.1:$PORT/login" -o /dev/null || [ $t -ge 90 ]; do sleep 2; t=$((t + 2)); done
				echo "$(date -u +%H:%M:%S) wrangler dev answering again after ${t}s" >> "$OUT/wrangler-restarts.log"
			fi
		fi
		sleep 3
	done
) &
for _ in $(seq 1 90); do
	if curl -sf "http://127.0.0.1:$PORT/login" -o /dev/null; then
		stamp "worker ready"
		touch "$OUT/server.ready"
		exit 0
	fi
	sleep 1
done
echo "wrangler dev did not answer /login"
exit 1
