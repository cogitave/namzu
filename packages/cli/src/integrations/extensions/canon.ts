import { createHash } from 'node:crypto'

/** Compact JSON with sorted keys and no spaces: the form every signed or hashed value here takes. */
export function canon(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>
		return `{${Object.keys(record)
			.sort()
			.filter((key) => record[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canon(record[key])}`)
			.join(',')}}`
	}
	return JSON.stringify(value)
}

export function sha256Hex(data: string | Uint8Array): string {
	return createHash('sha256').update(data).digest('hex')
}
