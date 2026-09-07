/**
 * Serialize application data before sending it to the interpreter.
 *
 * JSON.stringify alone can allocate an arbitrarily large intermediate string.
 * This writer accounts for each piece, refuses cycles and non-JSON values, and
 * limits nesting. It never installs application objects in the guest realm.
 * Undefined is supported only as a top-level result, represented out of band.
 */
export function encodeCodeValue(value: unknown, maxBytes: number): string | undefined {
	if (value === undefined) return undefined
	const pieces: string[] = []
	const ancestors = new Set<object>()
	let bytes = 0

	const append = (text: string): void => {
		bytes += Buffer.byteLength(text)
		if (bytes > maxBytes) throw new Error(`Code runtime value exceeds ${maxBytes} bytes.`)
		pieces.push(text)
	}
	const quote = (text: string): void => {
		if (text.length > maxBytes - bytes) {
			throw new Error(`Code runtime value exceeds ${maxBytes} bytes.`)
		}
		append(JSON.stringify(text))
	}
	const visit = (item: unknown, depth: number): void => {
		if (depth > 64) throw new Error('Code runtime value exceeds 64 levels of nesting.')
		if (item === null) {
			append('null')
			return
		}
		if (typeof item === 'string') {
			quote(item)
			return
		}
		if (typeof item === 'boolean') {
			append(String(item))
			return
		}
		if (typeof item === 'number' && Number.isFinite(item)) {
			append(String(item))
			return
		}
		if (typeof item !== 'object') throw new Error('Code runtime values must be JSON-safe.')
		if (ancestors.has(item)) throw new Error('Code runtime values must not contain cycles.')
		const array = Array.isArray(item)
		if (
			!array &&
			Object.getPrototypeOf(item) !== Object.prototype &&
			Object.getPrototypeOf(item) !== null
		) {
			throw new Error('Code runtime values must contain only plain objects and arrays.')
		}
		ancestors.add(item)
		if (array) {
			if (item.length > maxBytes) throw new Error(`Code runtime value exceeds ${maxBytes} bytes.`)
			append('[')
			for (let index = 0; index < item.length; index++) {
				if (index > 0) append(',')
				visit(item[index], depth + 1)
			}
			append(']')
		} else {
			append('{')
			const keys = Object.keys(item)
			for (const [index, key] of keys.entries()) {
				if (index > 0) append(',')
				quote(key)
				append(':')
				const descriptor = Object.getOwnPropertyDescriptor(item, key)
				if (!descriptor || !('value' in descriptor)) {
					throw new Error('Code runtime values must not contain accessors.')
				}
				visit(descriptor.value, depth + 1)
			}
			append('}')
		}
		ancestors.delete(item)
	}
	visit(value, 0)
	return pieces.join('')
}
