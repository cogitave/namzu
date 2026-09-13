import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import {
	type JsonClaimRequirement,
	type RunId,
	createJsonClaimVerifier,
	generateRunId,
} from '@namzu/sdk'

export interface ResidentVerificationSpec {
	readonly version: 1
	readonly claims: readonly JsonClaimRequirement[]
}

/** Bounded regular-file observation; checks changes during the read, never runs commands. */
async function readDocument(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
	signal?.throwIfAborted()
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
	)
	try {
		const before = await file.stat()
		if (!before.isFile() || before.size >= maxBytes)
			throw new Error('Verification requires a bounded regular file.')
		const buffer = Buffer.alloc(before.size + 1)
		let length = 0
		while (length < buffer.length) {
			signal?.throwIfAborted()
			const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
			if (!bytesRead) break
			length += bytesRead
		}
		const after = await file.stat()
		const named = await stat(path)
		signal?.throwIfAborted()
		if (
			length !== before.size ||
			[after, named].some(
				(value) =>
					value.dev !== before.dev ||
					value.ino !== before.ino ||
					value.size !== before.size ||
					value.mtimeMs !== before.mtimeMs ||
					value.ctimeMs !== before.ctimeMs,
			)
		)
			throw new Error('Verification source changed during observation.')
		return buffer.subarray(0, length)
	} finally {
		await file.close()
	}
}

function within(root: string, path: string): boolean {
	const rel = relative(root, path)
	return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}

function validateSpec(value: unknown): ResidentVerificationSpec {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid verification specification.')
	const raw = value as Record<string, unknown>
	if (
		raw.version !== 1 ||
		!Array.isArray(raw.claims) ||
		Object.keys(raw).some((key) => !['version', 'claims'].includes(key))
	)
		throw new Error('Verification requires {"version":1,"claims":[...]} .')
	for (const claim of raw.claims) {
		if (
			!claim ||
			typeof claim !== 'object' ||
			Array.isArray(claim) ||
			Object.keys(claim).some((key) => !['id', 'source', 'pointer', 'expected'].includes(key)) ||
			typeof claim.source !== 'string' ||
			isAbsolute(claim.source) ||
			claim.source.includes('\\') ||
			claim.source.split('/').some((part: string) => !part || part === '..' || part === '.') ||
			/[\p{Cc}\p{Cf}]/u.test(claim.source)
		)
			throw new Error(
				'Verification sources must be relative workspace file paths without traversal.',
			)
	}
	const spec = structuredClone(value) as ResidentVerificationSpec
	// Validate the shared pointer/value/size contract before admitting a model.
	createJsonClaimVerifier({
		scope: 'configuration',
		runId: generateRunId(),
		requirements: spec.claims,
		observe: async () => {
			throw new Error('Configuration validation never observes sources.')
		},
	})
	return spec
}

/** Snapshot the explicitly selected manifest once; edits cannot expand a running worker's authority. */
export async function loadResidentVerification(
	path: string,
	cwd: string,
): Promise<ResidentVerificationSpec> {
	return validateSpec(
		JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(
				await readDocument(resolve(cwd, path), 65_536),
			),
		),
	)
}

/** Explicit host reads, like --gate: no additional authority is granted to model tools. */
export function residentClaimVerifier(
	spec: ResidentVerificationSpec,
	cwd: string,
	scope: string,
	runId: RunId,
) {
	const snapshot = validateSpec(spec)
	const verifier = createJsonClaimVerifier({
		scope,
		runId,
		requirements: snapshot.claims,
		observe: async (source, request) => {
			request.signal.throwIfAborted()
			const root = await realpath(cwd)
			if (root !== resolve(cwd)) throw new Error('Verification workspace identity changed.')
			const path = await realpath(resolve(cwd, source))
			if (!within(root, path)) throw new Error('Verification source escapes the workspace.')
			const bytes = await readDocument(path, request.maxBytes, request.signal)
			if ((await realpath(resolve(cwd, source))) !== path)
				throw new Error('Verification source moved.')
			return { ...request, source, bytes, kind: 'current', complete: true, observedAt: Date.now() }
		},
	})
	return verifier
}

export function verificationInstructions(spec: ResidentVerificationSpec): string {
	return [
		'For a complete decision, also include a claims object with exactly the configured IDs and observed scalar values.',
		'The host will independently re-read the selected JSON sources and reject mismatches or unmet expected values.',
		'Use blocked or wait when completion cannot be established; omit claims for those dispositions.',
		`Only these structured claims are verified, not the rest of the summary. Sources and JSON pointers: ${JSON.stringify(spec.claims)}`,
	].join(' ')
}
