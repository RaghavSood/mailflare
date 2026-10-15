import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { WebSocket, WebSocketServer } from "ws";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The self-hosted runtime's stand-in for RealtimeHub must count sockets the way the Durable Object
 * does: the push producer sends nothing to a user with an open socket, and a v2 page closes its
 * socket when it is hidden (#45), so a closed socket has to stop counting at once on both runtimes.
 */
const cacheDir = join(root, "node_modules", ".cache");
mkdirSync(cacheDir, { recursive: true });
const outDir = mkdtempSync(join(cacheDir, "mailflare-realtime-registry-test-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	stdin: { contents: `export { RealtimeHubRegistry } from "./server/runtime/realtime.ts";`, resolveDir: root, sourcefile: "realtime-registry-test-entry.js" },
	outfile: join(outDir, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["ws"],
	logLevel: "silent",
});
const { RealtimeHubRegistry } = await import(pathToFileURL(join(outDir, "entry.mjs")).href);

let server;
let registry;
let url;
before(async () => {
	registry = new RealtimeHubRegistry();
	server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	// Each client names its user in the path, as the server's upgrade handler does after authenticating.
	server.on("connection", (socket, request) => registry.attach(request.url.slice(1), socket));
	await new Promise((resolve) => server.once("listening", resolve));
	url = `ws://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const open = async (userId) => {
	const socket = new WebSocket(`${url}/${userId}`);
	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return socket;
};
const connections = async (userId) => (await (await registry.namespace().getByName(userId).fetch("https://mailflare-realtime/connections")).json()).connections;
const until = async (check, ms = 2_000) => {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (await check()) return true;
	return false;
};

test("a socket the page closes stops counting at once, and the page gets a clean close", async () => {
	const socket = await open("hidden-page");
	assert.equal(await connections("hidden-page"), 1);
	const closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
	socket.close(1000);
	assert.ok(await until(async () => (await connections("hidden-page")) === 0, 500), "the closed socket still counts as open");
	assert.equal(await closed, 1000, "the close was not answered");
});

test("a socket that drops without a close stops counting once the connection ends", async () => {
	const socket = await open("dropped");
	assert.equal(await connections("dropped"), 1);
	socket.terminate();
	assert.ok(await until(async () => (await connections("dropped")) === 0), "the dropped socket still counts as open");
});

test("each user counts only their own open sockets", async () => {
	const a = await open("user-a");
	const b1 = await open("user-b");
	const b2 = await open("user-b");
	assert.equal(await connections("user-a"), 1);
	assert.equal(await connections("user-b"), 2);
	b1.close();
	assert.ok(await until(async () => (await connections("user-b")) === 1), "user-b still counts the closed socket");
	assert.equal(await connections("user-a"), 1);
	for (const socket of [a, b2]) socket.close();
	assert.ok(await until(async () => (await connections("user-a")) + (await connections("user-b")) === 0));
});
