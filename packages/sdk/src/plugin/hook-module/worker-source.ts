/**
 * The program a hooks module runs in, as the text of a worker thread.
 *
 * It is text, not a file, so it runs the same from the SDK's own build, from a
 * bundle and from a test, with nothing to locate on disk. It is plain script:
 * `require` is the worker's own (there is no import in it), and it holds no
 * dependency.
 *
 * The module itself runs in a `node:vm` context of its own: the language's
 * builtins, a few web classes, `console`, and nothing else. No `require`, no
 * `process`, no timers, no network. What a module can do beyond computing goes
 * through `$`, and `$` is a set of messages to the host, which decides. This
 * keeps a module from reaching things by accident and from tripping over its
 * own globals; it is not a boundary against a module written to escape (a
 * context shares the worker's heap), which is why a module runs only after the
 * person has been told what it does.
 *
 * Messages to the worker: `load`, `dispatch`, `overrun`, `abort`, `call-result`.
 * Messages from it: `loaded`, `result`, `call`, `log`.
 */
export const HOOK_WORKER_SOURCE = String.raw`
'use strict'
const { parentPort } = require('node:worker_threads')
const vm = require('node:vm')

const post = (message) => parentPort.postMessage(message)
const MAX_LOG = 4000

const text = (value) => {
	if (typeof value === 'string') return value
	try {
		const json = JSON.stringify(value)
		return json === undefined ? String(value) : json
	} catch {
		return String(value)
	}
}
const log = (level, args) => post({ t: 'log', level, text: args.map(text).join(' ').slice(0, MAX_LOG) })
const messageOf = (error) =>
	error !== null && typeof error === 'object' && typeof error.message === 'string'
		? error.message
		: String(error)

const BUDGET = Object.freeze({ ms: 10000, catchMs: 1000, lingerMs: 5000 })

let context
let pluginName = ''
let pluginRoot = ''
let registrations = []
let registering = true
let nextCall = 1
const pendingCalls = new Map()
const dispatches = new Map()

function call(noun, method, args) {
	return new Promise((resolve, reject) => {
		const id = nextCall++
		pendingCalls.set(id, { resolve, reject })
		post({ t: 'call', cid: id, noun, method, args })
	})
}

function unavailable(path) {
	return () => {
		throw new Error(path + ' is not available in Namzu')
	}
}

// One noun of $: the calls Namzu answers go to the host, any other name throws where it is called.
function noun(name, methods) {
	const target = {}
	for (const method of methods) {
		target[method] = (...args) => call(name, method, args)
	}
	Object.freeze(target)
	return new Proxy(target, {
		get(object, key) {
			if (typeof key !== 'string') return undefined
			if (Object.prototype.hasOwnProperty.call(object, key)) return object[key]
			return unavailable('$.' + name + '.' + key)
		},
		set() {
			throw new TypeError('$ cannot be changed')
		},
		defineProperty() {
			throw new TypeError('$ cannot be changed')
		},
		deleteProperty() {
			throw new TypeError('$ cannot be changed')
		},
	})
}

function makeDollar(methodsByNoun) {
	const nouns = { plugin: Object.freeze({ name: pluginName, root: pluginRoot }) }
	for (const key of Object.keys(methodsByNoun)) nouns[key] = noun(key, methodsByNoun[key])
	Object.freeze(nouns)
	return new Proxy(nouns, {
		get(object, key) {
			if (typeof key !== 'string') return undefined
			if (Object.prototype.hasOwnProperty.call(object, key)) return object[key]
			return noun(key, [])
		},
		set() {
			throw new TypeError('$ cannot be changed')
		},
		defineProperty() {
			throw new TypeError('$ cannot be changed')
		},
		deleteProperty() {
			throw new TypeError('$ cannot be changed')
		},
	})
}

function deepFreeze(value, seen) {
	if (value === null || typeof value !== 'object' || seen.has(value)) return value
	seen.add(value)
	for (const key of Object.keys(value)) deepFreeze(value[key], seen)
	return Object.freeze(value)
}

const isRegExp = (value) => Object.prototype.toString.call(value) === '[object RegExp]'

// A matcher is an object of fields of the event: a scalar is ===, a RegExp tests the value as
// a string, an array matches if any element does, an object is a partial of an object.
function matchValue(matcher, value) {
	if (isRegExp(matcher)) {
		matcher.lastIndex = 0
		return typeof value === 'string' || typeof value === 'number' ? matcher.test(String(value)) : false
	}
	if (Array.isArray(matcher)) return matcher.some((item) => matchValue(item, value))
	if (matcher !== null && typeof matcher === 'object') {
		if (value === null || typeof value !== 'object') return false
		return Object.keys(matcher).every((key) => matchValue(matcher[key], value[key]))
	}
	return matcher === value
}

function matches(matcher, event) {
	if (matcher === undefined) return true
	return matchValue(matcher, event)
}

function loadProgram(program) {
	const cache = new Map()
	const load = (rel) => {
		const cached = cache.get(rel)
		if (cached !== undefined) return cached
		const exports = Object.create(null)
		cache.set(rel, exports)
		const source = program.files[rel]
		if (typeof source !== 'string') throw new Error('no such file in the module: ' + rel)
		const script = new vm.Script('(function (__exports, __import) {"use strict";' + source + '\n})', {
			filename: 'plugin:' + rel,
		})
		script.runInContext(context)(exports, load)
		return exports
	}
	return load(program.entry)
}

function freezeIntrinsics() {
	vm.runInContext(
		'(function () {' +
			'const keep = new Set(["Object", "Error"]);' +
			'for (const name of ["Object", "Array", "Function", "String", "Number", "Boolean", "Symbol", "Promise", "RegExp", "Date", "Map", "Set", "WeakMap", "WeakSet", "Error", "TypeError", "RangeError", "SyntaxError", "BigInt", "ArrayBuffer", "Uint8Array"]) {' +
			'const ctor = globalThis[name];' +
			'if (!ctor) continue;' +
			'if (ctor.prototype && !keep.has(name)) Object.freeze(ctor.prototype);' +
			'Object.freeze(ctor);' +
			'}' +
			'for (const name of ["JSON", "Math", "Reflect"]) { if (globalThis[name]) Object.freeze(globalThis[name]); }' +
			'for (const key of Reflect.ownKeys(globalThis)) {' +
			'const d = Object.getOwnPropertyDescriptor(globalThis, key);' +
			'if (d && d.configurable && "value" in d) Object.defineProperty(globalThis, key, { value: d.value, writable: false, configurable: false, enumerable: d.enumerable });' +
			'}' +
			'})()',
		context,
	)
}

async function load(message) {
	pluginName = message.name
	pluginRoot = message.root
	const dollar = makeDollar(message.nouns)
	globalThisDollar = dollar
	const options = deepFreeze(message.options || {}, new Set())
	const consoleShim = {}
	for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
		consoleShim[level] = (...args) => log(level, args)
	}
	const sandbox = {
		console: Object.freeze(consoleShim),
		URL,
		URLSearchParams,
		TextEncoder,
		TextDecoder,
		AbortController,
		AbortSignal,
		atob,
		btoa,
		structuredClone,
	}
	context = vm.createContext(sandbox, { name: 'plugin:' + pluginName })
	freezeIntrinsics()
	const exports = loadProgram(message.program)
	const register = typeof exports.register === 'function' ? exports.register : exports.default
	if (typeof register !== 'function') {
		throw new Error('the module does not export a function named register')
	}
	const on = (pattern, second, third) => {
		if (!registering) throw new Error('on() is called while register() runs, not after')
		const hasMatcher = third !== undefined
		const hook = hasMatcher ? third : second
		if (typeof pattern !== 'string') throw new TypeError('the event name passed to on() is not a string')
		if (typeof hook !== 'function') throw new TypeError('on("' + pattern + '") needs a function as its hook')
		const entry = { pattern, matcher: hasMatcher ? second : undefined, hasMatcher, hook, catcher: undefined }
		registrations.push(entry)
		return Object.freeze({
			catch(handler) {
				if (!registering) throw new Error('.catch() is set while register() runs, not after')
				if (typeof handler !== 'function') throw new TypeError('.catch() takes a function')
				if (entry.catcher !== undefined) throw new Error('on("' + pattern + '") already has a .catch')
				entry.catcher = handler
			},
		})
	}
	const answered = register(on, options)
	if (answered !== null && typeof answered === 'object' && typeof answered.then === 'function') {
		await answered
	}
	registering = false
	post({
		t: 'loaded',
		registrations: registrations.map((entry) => ({ pattern: entry.pattern, hasMatcher: entry.hasMatcher })),
	})
}

let globalThisDollar

function failure(error) {
	return messageOf(error)
}

async function dispatch(message) {
	const controller = new AbortController()
	const state = { controller, overrun: undefined, rejectOverrun: undefined, graceOver: undefined, rejectGrace: undefined }
	state.overrun = new Promise((_, reject) => {
		state.rejectOverrun = reject
	})
	state.overrun.catch(() => undefined)
	state.graceOver = new Promise((_, reject) => {
		state.rejectGrace = reject
	})
	state.graceOver.catch(() => undefined)
	dispatches.set(message.id, state)
	const failures = []
	const event = deepFreeze(message.e, new Set())

	const run = async (position, current) => {
		if (position >= message.regs.length) return {}
		const entry = registrations[message.regs[position]]
		if (!matches(entry.matcher, current)) return run(position + 1, current)
		let called = false
		let beneath
		const next = (changed) => {
			if (!called) {
				called = true
				beneath = run(position + 1, changed === undefined ? current : changed)
			}
			return beneath
		}
		const nextFor = (extra) => {
			const api = (changed) => next(changed)
			Object.assign(api, {
				signal: controller.signal,
				event: message.name,
				origin: Object.freeze({ plugin: pluginName }),
				budget: BUDGET,
				to: (changed) => next(changed),
				is: (pattern) =>
					pattern === message.name ||
					pattern === '*' ||
					(pattern.endsWith('.*') && message.name.startsWith(pattern.slice(0, -1))),
				...extra,
			})
			Object.defineProperty(api, 'called', { get: () => called })
			return api
		}
		let value
		try {
			value = await Promise.race([
				Promise.resolve().then(() => entry.hook(globalThisDollar, current, nextFor({}))),
				state.overrun,
			])
			if (value === undefined) throw new Error('the hook returned nothing')
			return value
		} catch (error) {
			const why = entry.pattern + ': ' + failure(error)
			if (entry.catcher !== undefined) {
				try {
					const answer = await Promise.race([
						Promise.resolve().then(() => entry.catcher(globalThisDollar, current, nextFor({ error: failure(error) }))),
						state.graceOver,
					])
					if (answer !== undefined) return answer
				} catch (inner) {
					failures.push(why + ' (and its .catch: ' + failure(inner) + ')')
					return called ? beneath : run(position + 1, current)
				}
			}
			failures.push(why)
			// The failed hook is absent: what is beneath it answers.
			return called ? beneath : run(position + 1, current)
		}
	}

	try {
		const value = await run(0, event)
		post({ t: 'result', id: message.id, ok: true, value, failures })
	} catch (error) {
		post({ t: 'result', id: message.id, ok: false, message: failure(error), failures })
	} finally {
		dispatches.delete(message.id)
	}
}

parentPort.on('message', (message) => {
	switch (message.t) {
		case 'load':
			load(message).catch((error) => post({ t: 'loaded', error: failure(error) }))
			return
		case 'dispatch':
			dispatch(message)
			return
		case 'overrun': {
			const state = dispatches.get(message.id)
			if (state !== undefined) {
				state.controller.abort()
				state.rejectOverrun(new Error('exceeded ' + BUDGET.ms + 'ms budget'))
			}
			return
		}
		case 'grace-over': {
			const state = dispatches.get(message.id)
			if (state !== undefined) state.rejectGrace(new Error('its .catch did not answer within the grace'))
			return
		}
		case 'abort': {
			const state = dispatches.get(message.id)
			if (state !== undefined) state.controller.abort()
			return
		}
		case 'call-result': {
			const pending = pendingCalls.get(message.cid)
			if (pending === undefined) return
			pendingCalls.delete(message.cid)
			if (message.ok) pending.resolve(message.value)
			else pending.reject(new Error(message.message))
			return
		}
	}
})

process.on('unhandledRejection', (reason) => log('error', ['an unhandled rejection: ' + failure(reason)]))
process.on('uncaughtException', (error) => log('error', ['an uncaught error: ' + failure(error)]))
`
