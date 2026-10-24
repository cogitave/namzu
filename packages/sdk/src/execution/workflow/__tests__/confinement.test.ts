import { describe, expect, it, vi } from "vitest";

import type { CodeRuntime, RunCodeOptions } from "../../code-runtime/types.js";
import { WorkflowRuntime } from "../runtime.js";
import { META, makeHost, runScript } from "./host.js";

// Every test here starts a real worker thread and a fresh QuickJS interpreter,
// about 0.3 s on an idle machine. That is scheduler-bound, not logic-bound: on
// a CPU-starved CI runner one run was measured at several seconds, so Vitest's
// five-second default decided the outcome by machine speed. The interrupt
// tests are bounded by CPU budgets inside the interpreter (not by this
// timeout), so a genuine hang still ends in the generous limit below.
vi.setConfig({ testTimeout: 60_000 });

describe("the script runs in the interpreter and reaches nothing of the host", () => {
	// SharedArrayBuffer is a QuickJS intrinsic with nothing to share with: there
	// is no second thread inside the interpreter and none can be created.
	it("sees none of the Node or web globals", async () => {
		const { result } = await runScript(`${META}
			return [typeof require, typeof process, typeof module, typeof exports, typeof Buffer, typeof fetch,
				typeof XMLHttpRequest, typeof WebSocket, typeof setTimeout, typeof setInterval, typeof setImmediate,
				typeof queueMicrotask, typeof clearTimeout, typeof WebAssembly,
				typeof Worker, typeof MessageChannel, typeof performance, typeof console, typeof structuredClone,
				typeof __dirname, typeof global, typeof self, typeof window]`);
		expect(result.result).toEqual(Array(23).fill("undefined"));
	});

	it("has no bridge natives: only the workflow globals exist", async () => {
		const { result } = await runScript(`${META}
			return { call: typeof call, print: typeof print, keys: Object.getOwnPropertyNames(globalThis).filter((k) =>
				['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget'].includes(k)).sort() }`);
		expect(result.result).toEqual({
			call: "undefined",
			print: "undefined",
			keys: ["agent", "args", "budget", "log", "parallel", "phase", "pipeline"],
		});
	});

	it.each([
		'return ({}).constructor.constructor("return typeof process")()',
		'return (async () => {}).constructor("return typeof require")() instanceof Promise ? "p" : "x"',
		'return Function("return typeof globalThis.process")()',
		'return agent.constructor("return typeof process")()',
		'return (0, eval)("typeof require")',
	])(
		"keeps constructor and eval escapes inside the interpreter: %s",
		async (body) => {
			const { result } = await runScript(`${META}${body}`);
			expect(result.status).toBe("completed");
			expect(["undefined", "p"]).toContain(result.result);
		},
	);

	it("refuses dynamic import of a Node module", async () => {
		const { result } = await runScript(
			`${META}try { await import('node:fs'); return 'loaded' } catch { return 'refused' }`,
		);
		expect(result.result).toBe("refused");
	});

	it("cannot call the host except through agent(), and gets nothing from the global object", async () => {
		const host = makeHost();
		const { result } = await runScript(
			`${META}
			const leaked = []
			for (const k of Object.getOwnPropertyNames(globalThis)) {
				if (typeof globalThis[k] === 'function' && /^(call|print|require|fetch)$/.test(k)) leaked.push(k)
			}
			globalThis.agent = null // non-writable: stays the real one
			return { leaked, still: typeof agent }`,
			{ host },
		);
		expect(result.result).toEqual({ leaked: [], still: "function" });
		expect(host.started).toHaveLength(0);
	});

	it("starts every run with a fresh interpreter", async () => {
		await runScript(`${META}globalThis.leftOver = 17`);
		const { result } = await runScript(`${META}return typeof leftOver`);
		expect(result.result).toBe("undefined");
	});

	it("interrupts a synchronous busy loop", async () => {
		const { result } = await runScript(`${META}while (true) {}`, {
			limits: { cpuSliceMs: 50 },
		});
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/synchronous stretch/);
	});

	it("interrupts a loop of microtasks that never yields to the host", async () => {
		const { result } = await runScript(
			`${META}for (;;) { await Promise.resolve() }`,
			{
				limits: { cpuSliceMs: 60_000, cpuTotalMs: 100 },
			},
		);
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/in all/);
	});

	it("cannot catch the interrupt", async () => {
		const { result } = await runScript(
			`${META}try { while (true) {} } catch { return 'caught' }`,
			{
				limits: { cpuSliceMs: 50 },
			},
		);
		expect(result.status).toBe("failed");
	});

	it("refuses a script that exhausts interpreter memory", async () => {
		const { result } = await runScript(
			`${META}const a = []; for (;;) a.push('x'.repeat(1 << 20) + a.length)`,
			{ limits: { memoryLimitBytes: 16 * 1024 * 1024 } },
		);
		expect(result.status).toBe("failed");
	});
});

describe("what crosses the bridge is data, checked by the host", () => {
	it("rejects a cyclic schema before any agent starts", async () => {
		const host = makeHost();
		const { result } = await runScript(
			`${META}const s = {}; s.self = s
			try { await agent('x', { schema: s }); return 'sent' } catch (e) { return 'rejected' }`,
			{ host },
		);
		expect(result.result).toBe("rejected");
		expect(host.started).toHaveLength(0);
	});

	it("rejects a function-valued option and a non-plain object", async () => {
		const host = makeHost();
		const { result } = await runScript(
			`${META}const out = []
			for (const o of [{ schema: () => 1 }, { schema: new Date() }, { schema: 5 }, { label: {} }]) {
				try { await agent('x', o); out.push('sent') } catch (e) { out.push('rejected') }
			}
			return out`,
			{ host },
		);
		// A function-valued schema is dropped by JSON; the others are refused.
		expect(result.result).toEqual(["rejected", "rejected", "rejected", "sent"]);
		expect(host.started.length).toBeLessThanOrEqual(2);
	});

	it("rejects an oversized prompt without starting an agent", async () => {
		const host = makeHost();
		const { result } = await runScript(
			`${META}try { await agent('x'.repeat(300000)); return 'sent' } catch (e) { return e.message }`,
			{ host },
		);
		expect(String(result.result)).toMatch(/larger than/);
		expect(host.started).toHaveLength(0);
	});
});

/** A runtime that lets a test call the host handler with arbitrary input, as a compromised worker could. */
function hostile(payloads: { name: string; input: unknown }[]) {
	const replies: { ok: boolean; error?: string; value?: unknown }[] = [];
	const runtime: CodeRuntime = {
		id: "hostile",
		async run(options: RunCodeOptions) {
			for (const payload of payloads) {
				replies.push(
					await options.onHostCall(payload, {
						runtimeToolCallId: "1",
						signal: new AbortController().signal,
					}),
				);
			}
			return {
				outcome: { status: "completed", result: null },
				output: "",
				outputTruncated: false,
				calls: [],
			};
		},
	};
	return { runtime, replies };
}

describe("the host re-validates every call, whatever the worker sends", () => {
	it("answers only the agent call and refuses garbage payloads", async () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const { runtime, replies } = hostile([
			{ name: "fs.readFile", input: { path: "/etc/passwd" } },
			{ name: "agent", input: null },
			{ name: "agent", input: [] },
			{ name: "agent", input: "prompt" },
			{ name: "agent", input: { prompt: 5 } },
			{ name: "agent", input: { prompt: "" } },
			{ name: "agent", input: { prompt: "x", extra: 1 } },
			{ name: "agent", input: { prompt: "x".repeat(300_000) } },
			{ name: "agent", input: { prompt: () => "x" } },
			{ name: "agent", input: { prompt: "x", schema: cyclic } },
			{ name: "agent", input: { prompt: "x", schema: "nope" } },
			{
				name: "agent",
				input: { prompt: "x", schema: { type: "x".repeat(40_000) } },
			},
			{ name: "agent", input: { prompt: "x", label: "x".repeat(500) } },
			{ name: "agent", input: { prompt: "x", cursor: 7 } },
			{ name: "agent", input: { prompt: "x", model: {} } },
		]);
		const host = makeHost();
		const result = await new WorkflowRuntime({ codeRuntime: runtime }).run({
			script: `${META}return 1`,
			spawnAgent: host.spawnAgent,
		});
		expect(result.status).toBe("completed");
		expect(replies.every((r) => r.ok === false)).toBe(true);
		expect(replies[0]?.error).toMatch(/Unknown host call/);
		expect(replies.slice(1).every((r) => /agent\(\)/.test(r.error ?? ""))).toBe(
			true,
		);
		expect(host.started).toHaveLength(0);
		expect(result.usage.agents).toBe(0);
	});

	it("accepts a well-formed call", async () => {
		const { runtime, replies } = hostile([
			{ name: "agent", input: { prompt: "hi", cursor: null } },
		]);
		const host = makeHost();
		await new WorkflowRuntime({ codeRuntime: runtime }).run({
			script: `${META}return 1`,
			spawnAgent: host.spawnAgent,
		});
		expect(replies[0]).toEqual({ ok: true, value: { v: "ok:hi", t: 10 } });
	});
});
