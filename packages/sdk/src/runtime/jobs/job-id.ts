import { randomBytes } from 'node:crypto'

/**
 * Background job ids: `b` and eight characters of `0-9a-z`.
 *
 * Random rather than counted. A counter restarts with every registry, so a
 * resumed conversation that still says `job_1` about a dead job would be
 * answered by whatever job happens to be `job_1` in the new session. A random
 * id from a space of 36^8 does not collide across sessions in practice, and
 * the registry additionally never hands out one it already holds.
 *
 * Ids are opaque to callers: nothing may parse them or rely on the shape.
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const ID_BODY_LENGTH = 8
const ID_PATTERN = /^b[0-9a-z]{8}$/

/**
 * Whether `id` looks like one this SDK minted (`b` + 8 base36 characters).
 * A helper only: the tools do not gate on it, because a host's own registry
 * may use other ids. Ids are opaque; a host must not parse them.
 */
export function isBackgroundJobId(id: unknown): id is string {
	return typeof id === 'string' && ID_PATTERN.test(id)
}

/**
 * A fresh id. Bytes are mapped onto the alphabet by rejection so every
 * character is uniform (256 is not a multiple of 36).
 */
export function createBackgroundJobId(isTaken: (id: string) => boolean = () => false): string {
	for (;;) {
		let body = ''
		while (body.length < ID_BODY_LENGTH) {
			for (const byte of randomBytes(ID_BODY_LENGTH * 2)) {
				if (byte >= 252) continue // 252 = 36 * 7
				body += ALPHABET[byte % 36]
				if (body.length === ID_BODY_LENGTH) break
			}
		}
		const id = `b${body}`
		if (!isTaken(id)) return id
	}
}

const MAX_JOB_ID_INPUT_LENGTH = 128

/**
 * The tools' only gate on an id a caller passes in. A host may supply its own
 * registry with its own id format, so shape is NOT checked here: anything that
 * is a sane single token goes on to the registry, whose "No background job
 * <id>." answers for an unknown one. Returns a plain refusal for input that
 * cannot be an id at all (not a string, empty, over 128 characters, or
 * containing whitespace or control characters), otherwise undefined.
 */
export function invalidBackgroundJobIdInput(id: unknown): string | undefined {
	if (typeof id !== 'string' || id.length === 0) return 'A background job id is required.'
	if (id.length > MAX_JOB_ID_INPUT_LENGTH) {
		return `That is not a background job id: it is longer than ${MAX_JOB_ID_INPUT_LENGTH} characters.`
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
	if (/[\s\u0000-\u001f\u007f-\u009f]/u.test(id)) {
		return 'That is not a background job id: ids contain no spaces or control characters.'
	}
	return undefined
}
