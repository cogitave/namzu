// A stand-in for oxc-parser that reports the environment it was started with, as a string literal.
export function rawTransferSupported() {
	return false
}
export function parseSync() {
	const keys = JSON.stringify(Object.keys(process.env).sort())
	return {
		errors: [],
		program: { type: 'Program', start: 0, end: 1, body: [{ type: 'Literal', value: keys, start: 0, end: 1 }] },
	}
}
