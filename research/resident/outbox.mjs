import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DiskResidentAgenda,
	deliverResidentMessage,
	generateTenantId,
} from "../../packages/sdk/dist/index.js";

// Local synthetic destination only. No providers, user accounts or public endpoints.
const sourceFiles = [
	"packages/sdk/src/manager/resident/outbox.ts",
	"packages/sdk/src/manager/resident/agenda.ts",
	"packages/sdk/src/manager/resident/host.ts",
	"packages/sdk/src/manager/resident/store.ts",
	"packages/sdk/src/manager/resident/delivery-window.ts",
	"packages/sdk/dist/manager/resident/outbox.js",
	"packages/sdk/dist/manager/resident/agenda.js",
	"packages/sdk/dist/manager/resident/host.js",
	"packages/sdk/dist/manager/resident/delivery-window.js",
	"research/resident/outbox.mjs",
];
const repository = new URL("../../", import.meta.url);
const fingerprint = async () =>
	Object.fromEntries(
		await Promise.all(
			sourceFiles.map(async (path) => [
				path,
				createHash("sha256")
					.update(await readFile(new URL(path, repository)))
					.digest("hex"),
			]),
		),
	);
const fingerprints = await fingerprint();
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
	cwd: repository,
	encoding: "utf8",
}).trim();
const workingTreeDirty = Boolean(
	execFileSync("git", ["status", "--porcelain"], {
		cwd: repository,
		encoding: "utf8",
	}).trim(),
);
const root = await mkdtemp(join(tmpdir(), "namzu-resident-outbox-experiment-"));
const scope = { tenantId: generateTenantId(), agentKey: "local-notifier" };
const receipts = new Map();
let requestsReceived = 0;
let transportCalls = 0;
let clock = Date.now();
let port;
let agenda = new DiskResidentAgenda(root, scope);
const server = createServer(async (incoming, response) => {
	try {
		requestsReceived++;
		let body = "";
		for await (const chunk of incoming) body += chunk.toString("utf8");
		const input = JSON.parse(body);
		assert.equal(incoming.headers["idempotency-key"], input.id);
		assert.equal(incoming.method, "POST");
		const existing = receipts.get(input.id);
		if (existing) assert.equal(existing.body, input.body);
		const accepted = existing ?? {
			id: input.id,
			body: input.body,
			receiptId: `loopback:${input.id}`,
		};
		receipts.set(input.id, accepted);
		if (incoming.url === "/lose-ack") {
			// Acceptance already happened. Closing the connection hides its acknowledgment.
			incoming.socket.destroy();
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ receiptId: accepted.receiptId }));
	} catch (error) {
		response.writeHead(500, { "content-type": "text/plain" });
		response.end(String(error));
	}
});

function listen(requestedPort = 0) {
	return new Promise((resolve, reject) => {
		const failed = (error) => {
			server.off("listening", started);
			reject(error);
		};
		const started = () => {
			server.off("error", failed);
			resolve(server.address().port);
		};
		server.once("error", failed);
		server.once("listening", started);
		server.listen(requestedPort, "127.0.0.1");
	});
}

function close() {
	return new Promise((resolve, reject) => {
		if (!server.listening) return resolve();
		server.close((error) => (error ? reject(error) : resolve()));
		server.closeAllConnections();
	});
}

function transport(message, signal) {
	transportCalls++;
	const route =
		message.destination === "fixture:lost-ack" ? "/lose-ack" : "/accept";
	return new Promise((resolve, reject) => {
		let connected = false;
		const outgoing = request(
			{
				hostname: "127.0.0.1",
				port,
				path: route,
				method: "POST",
				agent: false,
				signal,
				headers: {
					"content-type": "application/json",
					"idempotency-key": message.id,
				},
			},
			(response) => {
				let body = "";
				response.on("data", (chunk) => {
					body += chunk.toString("utf8");
				});
				response.once("error", reject);
				response.once("end", () => {
					try {
						assert.equal(response.statusCode, 200);
						resolve({
							kind: "acknowledged",
							receiptId: JSON.parse(body).receiptId,
						});
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		outgoing.once("socket", (socket) => {
			socket.once("connect", () => {
				connected = true;
			});
		});
		outgoing.once("error", (error) => {
			if (!connected && error.code === "ECONNREFUSED") {
				// A refused connection to our closed fixture never transmitted a request.
				resolve({
					kind: "not-accepted",
					retryAt: clock + 10,
					reason:
						"Loopback destination refused the connection before acceptance.",
				});
			} else {
				// In particular, do not turn an acknowledgment lost after acceptance into retry.
				reject(error);
			}
		});
		outgoing.end(JSON.stringify({ id: message.id, body: message.body }));
	});
}

const options = {
	signal: AbortSignal.timeout(15_000),
	gate: () => ({ allow: true }),
	now: () => clock,
};

try {
	const pursuit = await agenda.add(
		await agenda.create("A careful notifier"),
		"Report one finding.",
	);
	const claim = await agenda.execution(pursuit.id).claim(pursuit.state, clock);
	const firstId = randomUUID();
	await agenda.settleWithMessage(
		pursuit.id,
		claim,
		{
			kind: "complete",
			summary: "Finding verified; destination acceptance is still pending.",
		},
		{
			id: firstId,
			pursuitId: pursuit.id,
			destination: "fixture:operator",
			body: "One verified finding is ready.",
			notBefore: 0,
		},
		clock,
	);
	port = await listen();
	await close();
	const disconnected = await deliverResidentMessage(agenda, transport, options);
	assert.equal(disconnected.status, "settled");
	assert.equal(disconnected.message.phase, "pending");
	assert.equal(disconnected.message.attempts, 1);
	assert.equal(receipts.size, 0);
	assert.equal(requestsReceived, 0);

	// The retry intent survives reopening. Reconnect only to the same owned fixture.
	agenda = new DiskResidentAgenda(root, scope);
	assert.equal((await agenda.read()).outbox[0].phase, "pending");
	await listen(port);
	clock += 11;
	const reconnected = await deliverResidentMessage(agenda, transport, options);
	assert.equal(reconnected.status, "settled");
	assert.equal(reconnected.message.phase, "acknowledged");
	assert.equal(reconnected.message.attempts, 2);
	assert.equal(receipts.size, 1);
	assert.equal(requestsReceived, 1);

	const lostId = randomUUID();
	await agenda.enqueueMessage(await agenda.read(), {
		id: lostId,
		pursuitId: pursuit.id,
		destination: "fixture:lost-ack",
		body: "A second finding whose acknowledgment will be lost.",
		notBefore: 0,
	});
	let lostAckError;
	try {
		await deliverResidentMessage(agenda, transport, options);
	} catch (error) {
		lostAckError = error;
	}
	assert.ok(
		lostAckError,
		"Acceptance with a lost acknowledgment must remain uncertain.",
	);
	assert.ok(receipts.has(lostId));
	agenda = new DiskResidentAgenda(root, scope);
	const sending = (await agenda.read()).outbox.find(
		(message) => message.id === lostId,
	);
	assert.equal(sending.phase, "sending");
	const beforeUnresolved = transportCalls;
	const unresolved = await deliverResidentMessage(agenda, transport, options);
	assert.equal(unresolved.status, "idle");
	assert.equal(unresolved.reason, "unresolved");
	assert.equal(transportCalls, beforeUnresolved);

	// The transport promise drained. Inspect the fixture's receipt before settling manually.
	const receipt = receipts.get(lostId);
	await agenda.settleMessage(
		sending,
		{ kind: "acknowledged", receiptId: receipt.receiptId },
		clock,
	);
	const quietId = randomUUID();
	await agenda.enqueueMessage(await agenda.read(), {
		id: quietId,
		pursuitId: pursuit.id,
		destination: "fixture:operator",
		body: "This finding must wait for the configured delivery window.",
		notBefore: 0,
	});
	const beforeQuiet = transportCalls;
	const quiet = await deliverResidentMessage(agenda, transport, {
		...options,
		gate: () => ({
			allow: false,
			nextCheckAt: clock + 60_000,
			reason: "Fixture quiet window.",
		}),
	});
	assert.equal(quiet.status, "idle");
	assert.equal(quiet.reason, "window");
	assert.equal(transportCalls, beforeQuiet);
	const state = await agenda.read();
	assert.equal(
		state.outbox.find((message) => message.id === quietId).attempts,
		0,
	);
	assert.equal(receipts.size, 2);
	assert.equal(requestsReceived, 2);
	assert.deepEqual(
		await fingerprint(),
		fingerprints,
		"Source/build changed during experiment",
	);
	const evidence = {
		revision,
		workingTreeDirty,
		fingerprints,
		root,
		fixture: "HTTP on 127.0.0.1 only",
		modelCalls: 0,
		transportCalls,
		requestsReceived,
		acceptedMessages: receipts.size,
		disconnected,
		reconnected,
		lostAcknowledgment: {
			error: String(lostAckError),
			unresolved,
			automaticallyRetried: false,
		},
		quiet,
		quietTransportCalls: transportCalls - beforeQuiet,
		state,
		limitations:
			"Synthetic local HTTP destination and controlled clock. Acknowledgment proves fixture acceptance, not human reading. No real notification channels, provider calls, multi-host service or exactly-once remote delivery claim.",
	};
	await writeFile(
		join(root, "evidence.json"),
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
	console.error(
		JSON.stringify(
			{ root, error: String(error), state: await agenda.read() },
			null,
			2,
		),
	);
	process.exitCode = 1;
} finally {
	await close();
}
