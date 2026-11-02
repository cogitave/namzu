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
		if (!t) throw misuse('phase() needs a non-empty title.');
		cursor = t;
		emit({ k: 'phase', title: t });
	}
	function log(message) {
		emit({ k: 'log', message: String(message).slice(0, 2000) });
	}
	function kind(value) {
		if (value === null) return 'null';
		if (value === '') return 'an empty string';
		if (Array.isArray(value)) return 'an array';
		var t = typeof value;
		if (t === 'undefined') return 'undefined';
		if (t === 'object') return typeof value.then === 'function' ? 'a promise' : 'an object';
		return 'a ' + t;
	}
	function overBudget() {
		return config.tokenLimit !== null && config.tokenLimit > 0 && spent.tokensUsed >= config.tokenLimit;
	}
	function budgetError() {
		var e = new Error('Workflow token budget exceeded (' + spent.tokensUsed.toLocaleString('en-US') + ' / ' + config.tokenLimit.toLocaleString('en-US') + ' output tokens). Stopping further agent() calls. Agents already running will finish and their results are kept.');
		e.name = 'WorkflowBudgetExceededError';
		return e;
	}
	function isBudgetError(e) { return !!e && e.name === 'WorkflowBudgetExceededError'; }
	function misuse(message) {
		var e = new TypeError(message);
		e.workflowMisuse = true;
		return e;
	}
	function isMisuse(e) { return !!e && e.workflowMisuse === true; }
	var optionNames = ['label', 'phase', 'schema', 'agentType', 'model', 'effort'];
	async function agent(prompt, opts) {
		if (typeof prompt !== 'string' || prompt.length === 0) {
			throw misuse('agent(prompt, options?): the prompt must be a non-empty string, got ' + kind(prompt));
		}
		var o = opts == null ? {} : opts;
		if (typeof o !== 'object' || Array.isArray(o)) {
			throw misuse('agent(prompt, options?): options must be an object, got ' + kind(o));
		}
		var unknown = Object.keys(o).filter(function (k) { return optionNames.indexOf(k) < 0; });
		if (unknown.length > 0) {
			// Ignored, as it always was, but no longer silently: a saved script that
			// misspells an option keeps running and the line says why it had no effect.
			log('agent(prompt, options?): ignoring unknown option "' + unknown[0] + '"; the options are ' + optionNames.join(', ') + '.');
		}
		if (overBudget()) throw budgetError();
		var request = { prompt: prompt, cursor: cursor };
		if (o.label != null) request.label = clean(o.label, 120);
		if (o.phase != null) request.phase = clean(o.phase, 120);
		if (o.schema != null) request.schema = o.schema;
		if (o.agentType != null) request.agentType = clean(o.agentType, 120);
		if (o.model != null) request.model = clean(o.model, 120);
		if (o.effort != null) request.effort = clean(o.effort, 32);
		var reply;
		try {
			reply = await rawCall('agent', request);
		} catch (e) {
			// The host rejects a malformed request with an "agent(): ..." message;
			// that is the script's mistake, not a failed child.
			if (e && typeof e.message === 'string' && e.message.indexOf('agent(): ') === 0) throw misuse(e.message);
			throw e;
		}
		spent.tokensUsed = reply.t;
		return reply.v;
	}
	async function parallel(thunks) {
		if (!Array.isArray(thunks)) {
			throw misuse('parallel(thunks): the argument must be an array of functions, got ' + kind(thunks));
		}
		for (var p = 0; p < thunks.length; p++) {
			if (typeof thunks[p] !== 'function') {
				throw misuse('parallel(thunks): item ' + (p + 1) + ' must be a function (wrap the work as () => agent(...)), got ' + kind(thunks[p]));
			}
		}
		var dropped = 0;
		var results = await Promise.all(thunks.map(function (t, n) {
			return Promise.resolve().then(t).catch(function (e) {
				if (isBudgetError(e)) { dropped++; return null; }
				if (isMisuse(e)) throw e;
				log('Step ' + (n + 1) + ' stopped: ' + clean(e && e.message ? e.message : e, 300));
				return null;
			});
		}));
		if (dropped > 0) log('parallel: ' + dropped + (dropped === 1 ? ' item' : ' items') + ' dropped because the token budget is spent.');
		return results;
	}
	async function pipeline(items) {
		if (!Array.isArray(items)) {
			throw misuse('pipeline(items, ...stages): the first argument must be an array, got ' + kind(items));
		}
		var stages = Array.prototype.slice.call(arguments, 1);
		for (var s = 0; s < stages.length; s++) {
			if (typeof stages[s] !== 'function') {
				throw misuse('pipeline(items, ...stages): stage ' + (s + 1) + ' must be a function, got ' + kind(stages[s]));
			}
		}
		if (items.length > 0 && overBudget()) throw budgetError();
		var dropped = 0;
		var results = await Promise.all(items.map(async function (item, index) {
			var value = item;
			for (var i = 0; i < stages.length; i++) {
				try {
					value = await stages[i](value, item, index);
				} catch (e) {
					if (isBudgetError(e)) { dropped++; return null; }
					if (isMisuse(e)) throw e;
					log('Item ' + (index + 1) + ' stopped at step ' + (i + 1) + ': ' + clean(e && e.message ? e.message : e, 300));
					return null;
				}
				if (value === null || value === undefined) return null;
			}
			return value;
		}));
		if (dropped > 0) log('pipeline: ' + dropped + (dropped === 1 ? ' item' : ' items') + ' dropped because the token budget is spent.');
		return results;
	}
	var budget = Object.freeze({
		get total() { return config.tokenLimit; },
		spent: function () { return spent.tokensUsed; },
		remaining: function () {
			return config.tokenLimit === null ? Infinity : Math.max(0, config.tokenLimit - spent.tokensUsed);
		},
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
	if (config.deterministic) {
		var RealDate = Date;
		var clockMessage = 'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps through args.';
		var randomMessage = 'Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.';
		var ShimDate = function Date(a, b, c, d, e, f, g) {
			if (!new.target || arguments.length === 0) throw new Error(clockMessage);
			return Reflect.construct(RealDate, Array.prototype.slice.call(arguments), new.target === ShimDate ? RealDate : new.target);
		};
		Object.defineProperty(ShimDate, 'prototype', { value: RealDate.prototype, writable: false, configurable: false });
		Object.defineProperty(ShimDate, 'now', { value: function now() { throw new Error(clockMessage); }, writable: false, configurable: false });
		Object.defineProperty(ShimDate, 'parse', { value: RealDate.parse, writable: false, configurable: false });
		Object.defineProperty(ShimDate, 'UTC', { value: RealDate.UTC, writable: false, configurable: false });
		Object.defineProperty(RealDate.prototype, 'constructor', { value: ShimDate, writable: false, configurable: false });
		Object.defineProperty(globalThis, 'Date', { value: ShimDate, writable: false, configurable: false, enumerable: false });
		Object.defineProperty(Math, 'random', { value: function random() { throw new Error(randomMessage); }, writable: false, configurable: false });
		try { delete globalThis.eval; } catch (ignored) {}
		Object.freeze(RealDate);
	}
})`

/**
 * Lines the prelude occupies in the interpreter source, plus the newline that
 * joins it to the script body: subtract this from an interpreter line number
 * to get the line in the script the author wrote.
 */
export function preludeLineCount(config: {
	args: unknown
	tokenLimit: number | null
	deterministic?: boolean
}): number {
	return buildPrelude(config).split('\n').length
}

/** Source that installs the workflow globals, ready to prepend to a script body. */
export function buildPrelude(config: {
	args: unknown
	tokenLimit: number | null
	deterministic?: boolean
}): string {
	const literal = JSON.stringify(config)
		.split(String.fromCharCode(0x2028))
		.join('\\u2028')
		.split(String.fromCharCode(0x2029))
		.join('\\u2029')
	return `${PRELUDE_SOURCE}(${literal});`
}
