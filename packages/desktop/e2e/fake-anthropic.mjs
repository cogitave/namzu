// A scripted Anthropic Messages server. No network, no model.
// Same shape as fake-model.mjs: a rule matches the newest user text; its steps are consumed by the
// number of tool results already present after that message, so replay is a pure function of the
// request and never depends on timing.
// It also refuses what the real service refuses about history: a tool_use that is not answered by a
// tool_result in the very next message, a tool_result for a call that was never made, and a thinking
// block without a signature. A conversation carried over from another provider is tested against that.
import { createServer } from "node:http";

/** @typedef {{ text?: string, thinking?: string, tool?: string, args?: object } | { status: number, body?: string, headers?: object, contentType?: string }} Step */

export async function startFakeAnthropic(rules = [], options = {}) {
	const requests = [];
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
						data: (options.models ?? ["claude-sonnet-5-5", "claude-haiku-5-5"]).map((id) => ({
							type: "model",
							id,
							display_name: id,
							created_at: "2026-01-01T00:00:00Z",
						})),
						has_more: false,
						first_id: null,
						last_id: null,
					}),
				);
				return;
			}
			const parsed = body ? JSON.parse(body) : {};
			requests.push(parsed);
			const refusal = refuse(parsed.messages ?? []);
			if (refusal) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						type: "error",
						error: { type: "invalid_request_error", message: refusal },
					}),
				);
				return;
			}
			respond(res, parsed, pick(rules, parsed.messages ?? []));
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		rules,
		close: () =>
			new Promise((r) => {
				server.closeAllConnections?.();
				server.close(r);
			}),
	};
}

const blocks = (c) => (typeof c === "string" ? [{ type: "text", text: c }] : (c ?? []));

function refuse(messages) {
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const calls = blocks(m.content)
			.filter((b) => b.type === "tool_use")
			.map((b) => b.id);
		for (const b of blocks(m.content))
			if (b.type === "thinking" && !b.signature)
				return "messages: thinking block without a signature";
		const next = blocks(messages[i + 1]?.content);
		for (const id of calls)
			if (!next.some((b) => b.type === "tool_result" && b.tool_use_id === id))
				return `messages.${i}: tool_use ids were found without tool_result blocks immediately after: ${id}`;
	}
	const made = new Set();
	for (const m of messages) {
		for (const b of blocks(m.content)) {
			if (b.type === "tool_use") made.add(b.id);
			if (b.type === "tool_result" && !made.has(b.tool_use_id))
				return `unexpected tool_use_id found in tool_result blocks: ${b.tool_use_id}`;
		}
	}
	return undefined;
}

function pick(rules, messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== "user") continue;
		const prompt = blocks(messages[i].content)
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("");
		if (!prompt) continue;
		const toolResults = messages
			.slice(i + 1)
			.flatMap((m) => blocks(m.content))
			.filter((b) => b.type === "tool_result").length;
		for (const rule of rules) {
			if (rule.match.test(prompt))
				return rule.steps[Math.min(toolResults, rule.steps.length - 1)];
		}
	}
	return { text: "Scripted default reply." };
}

function respond(res, request, step) {
	if (step.status) {
		res.writeHead(step.status, {
			"content-type": step.contentType ?? "application/json",
			...(step.headers ?? {}),
		});
		res.end(step.body ?? "");
		return;
	}
	const content = [];
	if (step.thinking)
		content.push({ type: "thinking", thinking: step.thinking, signature: "sig-e2e-signed-1" });
	if (step.text) content.push({ type: "text", text: step.text });
	if (step.tool)
		content.push({
			type: "tool_use",
			id: `toolu_${Math.abs(hash(JSON.stringify(step)))}`,
			name: step.tool,
			input: step.args ?? {},
		});
	const stop = step.tool ? "tool_use" : "end_turn";
	const usage = { input_tokens: 10, output_tokens: 5 };
	const message = {
		id: "msg_e2e",
		type: "message",
		role: "assistant",
		model: request.model,
		content,
		stop_reason: stop,
		stop_sequence: null,
		usage,
	};
	if (!request.stream) {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(message));
		return;
	}
	res.writeHead(200, { "content-type": "text/event-stream" });
	const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	ev("message_start", { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
	content.forEach((block, index) => {
		if (block.type === "thinking") {
			ev("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
			ev("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } });
			ev("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } });
		} else if (block.type === "text") {
			ev("content_block_start", { index, content_block: { type: "text", text: "" } });
			ev("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
		} else {
			ev("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
			ev("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
		}
		ev("content_block_stop", { index });
	});
	ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
	ev("message_stop", {});
	res.end();
}

function hash(s) {
	let h = 0;
	for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
	return h;
}
