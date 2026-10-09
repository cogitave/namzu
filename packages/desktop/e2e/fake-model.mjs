// A scripted chat-completions server. No network, no model.
// A rule matches the latest user message; its steps are consumed by the number
// of tool results already present after that message, so replay is a pure
// function of the request and never depends on timing.
import { createServer } from "node:http";

/** @typedef {{ text: string } | { tool: string, args: object }} Step */

export async function startFakeModel(rules = [], options = {}) {
	const requests = [];
	const holds = new Map();
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			const url = new URL(req.url, "http://x");
			if (url.pathname.endsWith("/models")) {
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify({
						object: "list",
						data: (options.models ?? ["gpt-e2e-1", "gpt-e2e-0"]).map((id) => ({
							id,
							object: "model",
							created: 1,
							owned_by: "e2e",
						})),
					}),
				);
				return;
			}
			const parsed = body ? JSON.parse(body) : {};
			requests.push(parsed);
			const step = pick(rules, parsed.messages ?? []);
			const emit = () => respond(res, parsed, step);
			if (step.hold) {
				const entry = holds.get(step.hold) ?? { released: false, waiters: [] };
				holds.set(step.hold, entry);
				if (!entry.released) {
					entry.waiters.push(emit);
					// A request's own "close" fires once its body was read, long before the client
					// goes away; only the response closing early means the caller gave up.
					res.on("close", () => {
						if (!res.writableEnded)
							entry.waiters = entry.waiters.filter((w) => w !== emit);
					});
					return;
				}
			}
			emit();
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		/** Release a reply parked with `hold: name`. */
		release(name) {
			const entry = holds.get(name) ?? { released: false, waiters: [] };
			holds.set(name, entry);
			entry.released = true;
			for (const w of entry.waiters.splice(0)) w();
		},
		close: () =>
			new Promise((r) => {
				server.closeAllConnections?.();
				server.close(r);
			}),
	};
}

const textOf = (c) =>
	typeof c === "string"
		? c
		: Array.isArray(c)
			? c.map((p) => p.text ?? "").join("")
			: "";

function pick(rules, messages) {
	// The newest user message that a rule claims wins; the host may append its own
	// context messages after the person's prompt, so the very last one is not enough.
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== "user") continue;
		const prompt = textOf(messages[i].content);
		const toolResults = messages
			.slice(i + 1)
			.filter((m) => m.role === "tool").length;
		for (const rule of rules) {
			if (rule.match.test(prompt))
				return rule.steps[Math.min(toolResults, rule.steps.length - 1)];
		}
	}
	return { text: "Scripted default reply." };
}

function respond(res, request, step) {
	// A provider failure: `{ status, body, headers }` answers with that HTTP status instead of a reply.
	if (step.status) {
		res.writeHead(step.status, {
			"content-type": step.contentType ?? "application/json",
			...(step.headers ?? {}),
		});
		res.end(step.body ?? "");
		return;
	}
	const id = "chatcmpl-e2e";
	const message = step.tool
		? {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: `call_${Math.abs(hash(JSON.stringify(step)))}`,
						type: "function",
						function: {
							name: step.tool,
							arguments: JSON.stringify(step.args ?? {}),
						},
					},
				],
			}
		: { role: "assistant", content: step.text };
	const finish = step.tool ? "tool_calls" : "stop";
	const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
	if (!request.stream) {
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				id,
				object: "chat.completion",
				created: 1,
				model: request.model,
				choices: [{ index: 0, message, finish_reason: finish }],
				usage,
			}),
		);
		return;
	}
	res.writeHead(200, { "content-type": "text/event-stream" });
	const chunk = (delta, reason) =>
		`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
	if (step.tool) {
		const call = message.tool_calls[0];
		res.write(
			chunk(
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							index: 0,
							id: call.id,
							type: "function",
							function: {
								name: call.function.name,
								arguments: call.function.arguments,
							},
						},
					],
				},
				null,
			),
		);
	} else res.write(chunk({ role: "assistant", content: step.text }, null));
	res.write(chunk({}, finish));
	if (request.stream_options?.include_usage)
		res.write(
			`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: request.model, choices: [], usage })}\n\n`,
		);
	res.end("data: [DONE]\n\n");
}

function hash(s) {
	let h = 0;
	for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
	return h;
}
