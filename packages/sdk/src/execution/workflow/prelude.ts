/**
 * The interpreter-side half of the workflow language: `agent`, `parallel`,
 * `pipeline`, `phase`, `log`, `args` and `budget`.
 *
 * This text runs INSIDE the QuickJS interpreter, ahead of the script body,
 * and is the only place those names are defined. It captures the two bridge
 * natives (`call`, `print`) in its own closure and deletes them from the
 * global object, so the script reaches the host only through `agent()`, and
 * `phase()`/`log()` can only emit well-formed records. None of this is a
 * security boundary: the host re-validates every request and treats every
 * printed line as untrusted text. The boundary is the interpreter itself.
 *
 * Written with String.raw and no backticks or substitutions so no escaping
 * layer can change what the interpreter parses.
 */
const PRELUDE_SOURCE = String.raw`(function (config) {
	'use strict';
	var rawCall = globalThis.call;
	var rawPrint = globalThis.print;
	delete globalThis.call;
	delete globalThis.print;
	var stringify = JSON.stringify;
	var spent = { tokensUsed: 0 };
	var cursor = null;
	function emit(record) { rawPrint(stringify(record)); }
	function clean(value, limit) {
		return String(value).replace(/\s+/g, ' ').trim().slice(0, limit);
	}
	function phase(title) {
		var t = clean(title, 120);
		if (!t) throw new TypeError('phase() needs a non-empty title.');
		cursor = t;
		emit({ k: 'phase', title: t });
	}
	function log(message) {
		emit({ k: 'log', message: String(message).slice(0, 2000) });
	}
	async function agent(prompt, opts) {
		if (typeof prompt !== 'string' || prompt.length === 0) {
			throw new TypeError('agent() needs a prompt string.');
		}
		var o = opts == null ? {} : opts;
		if (typeof o !== 'object') throw new TypeError('agent() options must be an object.');
		var request = { prompt: prompt, cursor: cursor };
		if (o.label != null) request.label = clean(o.label, 120);
		if (o.phase != null) request.phase = clean(o.phase, 120);
		if (o.schema != null) request.schema = o.schema;
		if (o.agentType != null) request.agentType = clean(o.agentType, 120);
		if (o.model != null) request.model = clean(o.model, 120);
		if (o.effort != null) request.effort = clean(o.effort, 32);
		var reply = await rawCall('agent', request);
		spent.tokensUsed = reply.t;
		return reply.v;
	}
	async function parallel(thunks) {
		if (!Array.isArray(thunks)) throw new TypeError('parallel() needs an array of functions.');
		return Promise.all(thunks.map(function (t) { return typeof t === 'function' ? t() : t; }));
	}
	async function pipeline(items) {
		if (!Array.isArray(items)) throw new TypeError('pipeline() needs an array of items.');
		var stages = Array.prototype.slice.call(arguments, 1);
		for (var s = 0; s < stages.length; s++) {
			if (typeof stages[s] !== 'function') throw new TypeError('pipeline() stages must be functions.');
		}
		return Promise.all(items.map(async function (item, index) {
			var value = item;
			for (var i = 0; i < stages.length; i++) {
				value = await stages[i](value, index, item);
				if (value === null || value === undefined) return null;
			}
			return value;
		}));
	}
	var budget = Object.freeze({
		get tokensUsed() { return spent.tokensUsed; },
		get tokenLimit() { return config.tokenLimit === null ? undefined : config.tokenLimit; },
	});
	function install(name, value) {
		Object.defineProperty(globalThis, name, { value: value, writable: false, configurable: false, enumerable: true });
	}
	install('agent', agent);
	install('parallel', parallel);
	install('pipeline', pipeline);
	install('phase', phase);
	install('log', log);
	install('budget', budget);
	install('args', config.args);
})`

/** Source that installs the workflow globals, ready to prepend to a script body. */
export function buildPrelude(config: { args: unknown; tokenLimit: number | null }): string {
	const literal = JSON.stringify(config)
		.split(String.fromCharCode(0x2028))
		.join('\\u2028')
		.split(String.fromCharCode(0x2029))
		.join('\\u2029')
	return `${PRELUDE_SOURCE}(${literal});`
}
