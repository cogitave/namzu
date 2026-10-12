// A stand-in for `namzu computer status | setup | stop-idle --json`, for flows that walk the Pal
// computer row through the setup states on a machine that is not Windows. It answers from a script
// file the flow writes (NAMZU_E2E_COMPUTER_SCRIPT); nothing here touches an engine or the network.
//
// The script is JSON: { status, setup?: { before, gate, after, then }, idle? }
//   status  the object `status --json` prints (readiness and plan)
//   setup   lines printed before a gate, the gate (true: wait until `<script>.go` exists), the lines
//           printed after it, and the status that replaces `status` once the run ends
//   idle    the outcome `stop-idle --json` prints (default "stopped")
// Every call appends its arguments as one JSON line to `<script>.calls`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const line = (value) => process.stdout.write(`${JSON.stringify({ version: 1, ...value })}\n`);

export async function runComputerStandIn(args, script) {
	const state = JSON.parse(readFileSync(script, "utf8"));
	appendFileSync(`${script}.calls`, `${JSON.stringify(args)}\n`);
	const [verb] = args;
	if (verb === "status") {
		line(state.status);
	} else if (verb === "setup") {
		for (const entry of state.setup?.before ?? []) line(entry);
		if (state.setup?.gate) {
			// Wait for the flow to say go; Node's own test timeout ends a flow that never does.
			while (!existsSync(`${script}.go`)) await new Promise((done) => setTimeout(done, 25));
		}
		for (const entry of state.setup?.after ?? []) line(entry);
		if (state.setup?.then) writeFileSync(script, JSON.stringify({ ...state, status: state.setup.then }));
	} else if (verb === "stop-idle") {
		line({ outcome: state.idle ?? "stopped" });
	}
}
