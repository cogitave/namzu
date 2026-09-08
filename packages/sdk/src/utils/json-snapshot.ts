/** Clone JSON data without invoking getters or silently dropping values. */
export function cloneJsonValue(value: unknown, freeze: boolean, path = '$'): unknown {
	const active = new WeakSet<object>()
	const copies = new WeakMap<object, object>()

	const clone = (candidate: unknown, at: string): unknown => {
		if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
			return candidate
		}
		if (typeof candidate === 'number') {
			if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
				throw new TypeError(`${at} must be a finite JSON number`)
			}
			return candidate
		}
		if (typeof candidate !== 'object') {
			throw new TypeError(`${at} must be a JSON value, not ${typeof candidate}`)
		}
		if (active.has(candidate)) throw new TypeError(`${at} contains a cycle`)
		const existing = copies.get(candidate)
		if (existing) return existing

		active.add(candidate)
		try {
			if (Array.isArray(candidate)) {
				const extra = Reflect.ownKeys(candidate).filter(
					(key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)),
				)
				if (extra.length > 0) throw new TypeError(`${at} has non-JSON array properties`)
				const result: unknown[] = new Array(candidate.length)
				copies.set(candidate, result)
				for (let index = 0; index < candidate.length; index++) {
					const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index))
					if (!descriptor) throw new TypeError(`${at}[${index}] is a sparse array hole`)
					if (!descriptor.enumerable || !('value' in descriptor)) {
						throw new TypeError(`${at}[${index}] must be an enumerable data property`)
					}
					result[index] = clone(descriptor.value, `${at}[${index}]`)
				}
				if (freeze) Object.freeze(result)
				return result
			}

			const prototype = Object.getPrototypeOf(candidate)
			if (prototype !== Object.prototype && prototype !== null) {
				throw new TypeError(`${at} must be a plain JSON object`)
			}
			// JSON does not preserve prototypes. Canonicalize both admitted plain
			// shapes to an ordinary object so a disk checkpoint round-trip compares
			// equal to a fresh preparation of the same semantic value. Properties
			// are still defined explicitly, so a literal "__proto__" key remains
			// data rather than changing this object's prototype.
			const result: Record<string, unknown> = {}
			copies.set(candidate, result)
			for (const key of Reflect.ownKeys(candidate)) {
				if (typeof key !== 'string') throw new TypeError(`${at} has a symbol property`)
				const descriptor = Object.getOwnPropertyDescriptor(candidate, key)
				if (!descriptor?.enumerable || !('value' in descriptor)) {
					throw new TypeError(`${at}.${key} must be an enumerable data property`)
				}
				Object.defineProperty(result, key, {
					value: clone(descriptor.value, `${at}.${key}`),
					enumerable: true,
					writable: !freeze,
					configurable: !freeze,
				})
			}
			if (freeze) Object.freeze(result)
			return result
		} finally {
			active.delete(candidate)
		}
	}

	return clone(value, path)
}
