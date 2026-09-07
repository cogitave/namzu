/**
 * Trusted worker bootstrap. Only vm.evalCode executes the untrusted program.
 * Kept as source so installed/bundled SDKs need no separate worker entry file.
 * No Node object or callback is injected into QuickJS: its native functions
 * exchange bounded strings and interpreter-owned promise handles.
 */
export const QUICKJS_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { newQuickJSWASMModuleFromVariant, newVariant } = require(workerData.corePath)
const variantModule = require(workerData.variantPath)
const variant = variantModule.default || variantModule

async function main() {
	const limits = workerData.limits
	const pages = Math.floor(limits.memoryLimitBytes / 65536)
	const wasmMemory = new WebAssembly.Memory({ initial: Math.min(256, pages), maximum: pages })
	const module = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmMemory }))
	const runtime = module.newRuntime()
	runtime.setMemoryLimit(limits.memoryLimitBytes)
	runtime.setMaxStackSize(512 * 1024)
	runtime.setInterruptHandler(() => Date.now() >= workerData.deadline)
	const vm = runtime.newContext()
	const pending = new Map()
	let nextId = 0
	let printBytes = 0
	let printCount = 0
	let truncated = false
	let ended = false
	let pumping = false
	let scheduled = false
	let program
	const owned = []

	function keep(result) {
		const handle = vm.unwrapResult(result)
		owned.push(handle)
		return handle
	}
	// Capture intrinsics before the program may replace its own globals.
	const encode = keep(vm.evalCode('(' + function () {
		const stringify = JSON.stringify
		const finite = Number.isFinite
		const prototype = Object.getPrototypeOf
		const plain = Object.prototype
		const isArray = Array.isArray
		const keys = Object.keys
		const descriptor = Object.getOwnPropertyDescriptor
		return function (value) {
			if (value === undefined) return undefined
			const parents = new Set()
			function check(item, depth) {
				const kind = typeof item
				if (item === null || kind === 'string' || kind === 'boolean' || (kind === 'number' && finite(item))) return
				if (kind !== 'object' || depth > 64 || parents.has(item)) throw new Error('Code runtime values must be JSON-safe.')
				if (!isArray(item) && prototype(item) !== plain && prototype(item) !== null) throw new Error('Code runtime values must use plain objects and arrays.')
				parents.add(item)
				for (const key of keys(item)) {
					const property = descriptor(item, key)
					if (!property || !('value' in property)) throw new Error('Code runtime values must not contain accessors.')
					check(property.value, depth + 1)
				}
				parents.delete(item)
			}
			check(value, 0)
			return stringify(value)
		}
	}.toString() + ')()'))
	const decode = keep(vm.evalCode('(function () { const parse = JSON.parse; return function(value) { return parse(value); }; })()'))
	const errorText = keep(vm.evalCode('(function () { const string = String; return function(error) { try { return typeof error.message === "string" ? error.message : string(error); } catch { return "The program failed."; } }; })()'))

	function textValue(handle, maximum) {
		const length = vm.getProp(handle, 'length')
		try {
			if (vm.getNumber(length) > maximum) throw new Error('Code runtime value exceeds ' + maximum + ' bytes.')
		} finally { length.dispose() }
		const text = vm.getString(handle)
		if (Buffer.byteLength(text) > maximum) throw new Error('Code runtime value exceeds ' + maximum + ' bytes.')
		return text
	}
	function serialize(handle, maximum) {
		if (vm.typeof(handle) === 'undefined') return undefined
		const encoded = vm.callFunction(encode, vm.undefined, handle)
		if (encoded.error) {
			encoded.error.dispose()
			throw new Error('Code runtime values must be JSON-safe and serializable.')
		}
		try { return textValue(encoded.value, maximum) }
		finally { encoded.value.dispose() }
	}
	function failureText(handle) {
		const result = vm.callFunction(errorText, vm.undefined, handle)
		if (result.error) { result.error.dispose(); return 'The program failed.' }
		// Diagnostics have their own fixed bound. A deliberately tiny data
		// allowance must not erase the reason or the no-replay guidance for an
		// effect that completed but whose return value could not be delivered.
		try { return textValue(result.value, 4096) }
		catch { return 'The program failed with an oversized error.' }
		finally { result.value.dispose() }
	}
	function dispose() {
		for (const deferred of pending.values()) deferred.dispose()
		pending.clear()
		if (program && program.alive) program.dispose()
		for (const handle of owned) if (handle.alive) handle.dispose()
		vm.dispose()
		runtime.dispose()
	}
	function finish(message) {
		if (ended) return
		ended = true
		// A guest OOM can make QuickJS teardown throw. The worker still owns
		// the whole WASM module and is terminated by its parent on settlement.
		try { dispose() } catch {}
		parentPort.postMessage(message)
	}
	function fail(error) {
		finish(Date.now() >= workerData.deadline
			? { kind: 'timed-out' }
			: { kind: 'error', error: String(error && error.message || error).slice(0, 4096) })
	}
	function schedule() {
		if (ended || scheduled) return
		scheduled = true
		setImmediate(() => { scheduled = false; pump() })
	}
	function pump() {
		if (ended || pumping) return
		pumping = true
		try {
			const jobs = runtime.executePendingJobs(32)
			if (jobs.error) {
				const error = failureText(jobs.error)
				jobs.error.dispose()
				throw new Error(error)
			}
			const state = vm.getPromiseState(program)
			if (state.type === 'fulfilled') {
				let json
				try { json = serialize(state.value, limits.maxValueBytes) }
				finally { state.value.dispose() }
				finish({ kind: 'done', json })
			} else if (state.type === 'rejected') {
				let error
				try { error = failureText(state.error) }
				finally { state.error.dispose() }
				fail(new Error(error))
			} else if (runtime.hasPendingJob()) schedule()
		} catch (error) { fail(error) }
		finally { pumping = false }
	}
	function rejected(message) {
		const deferred = vm.newPromise()
		const error = vm.newError(message)
		deferred.reject(error)
		error.dispose()
		return deferred.handle
	}
	const call = vm.newFunction('call', (name, input = vm.undefined) => {
		try {
			if (nextId >= limits.maxHostCalls) return rejected('Code runtime host-call limit reached.')
			if (pending.size >= limits.maxPendingHostCalls) return rejected('Code runtime pending host-call limit reached.')
			if (vm.typeof(name) !== 'string') return rejected('A host call requires a tool name string.')
			const tool = textValue(name, Math.min(limits.maxValueBytes, 1024))
			const json = serialize(input, limits.maxValueBytes)
			const id = ++nextId
			const deferred = vm.newPromise()
			pending.set(id, deferred)
			parentPort.postMessage({ kind: 'call', id, name: tool, json })
			return deferred.handle
		} catch (error) { return rejected(String(error.message || error)) }
	})
	vm.setProp(vm.global, 'call', call)
	call.dispose()
	const print = vm.newFunction('print', (...values) => {
		if (truncated) return vm.undefined
		try {
			const parts = []
			let remaining = workerData.maxOutputBytes - printBytes - (printCount > 0 ? 1 : 0)
			for (const value of values) {
				if (parts.length) remaining--
				if (remaining < 0) throw new Error('output limit')
				const text = vm.typeof(value) === 'string' ? textValue(value, remaining) : serialize(value, remaining)
				const part = text === undefined ? '' : text
				remaining -= Buffer.byteLength(part)
				parts.push(part)
			}
			const line = parts.join(' ')
			const size = Buffer.byteLength(line) + (printCount > 0 ? 1 : 0)
			if (printBytes + size > workerData.maxOutputBytes) throw new Error('output limit')
			// Empty prints consume a newline after the first, so the byte
			// budget also bounds the number of worker messages.
			printBytes += size
			printCount++
			parentPort.postMessage({ kind: 'print', line })
		} catch {
			truncated = true
			parentPort.postMessage({ kind: 'truncated' })
		}
		return vm.undefined
	})
	vm.setProp(vm.global, 'print', print)
	print.dispose()

	parentPort.on('message', (message) => {
		if (ended || message.kind !== 'call-result') return
		const deferred = pending.get(message.id)
		if (!deferred) return
		pending.delete(message.id)
		try {
			if (message.ok) {
				let value = vm.undefined
				if (message.json !== undefined) {
					if (typeof message.json !== 'string' || Buffer.byteLength(message.json) > limits.maxValueBytes) throw new Error('Host result exceeds the value limit.')
					const input = vm.newString(message.json)
					try { value = vm.unwrapResult(vm.callFunction(decode, vm.undefined, input)) }
					finally { input.dispose() }
				}
				deferred.resolve(value)
				if (value !== vm.undefined) value.dispose()
			} else {
				const error = vm.newError(String(message.error).slice(0, 4096))
				deferred.reject(error)
				error.dispose()
			}
			deferred.dispose()
			schedule()
		} catch (error) { deferred.dispose(); fail(error) }
	})
	try {
		const result = vm.evalCode('(async () => {\\n' + workerData.source + '\\n})()', 'model-program.js')
		if (result.error) {
			const error = failureText(result.error)
			result.error.dispose()
			fail(new Error(error))
		} else { program = result.value; pump() }
	} catch (error) { fail(error) }
}
main().catch((error) => parentPort.postMessage({ kind: 'error', error: String(error && error.message || error).slice(0, 4096) }))
`
