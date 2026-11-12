// The manifest kernel-<channel>.json (specification 3.4): strict parse, and assembly from bundle
// entries plus the previous manifest. Rules the publisher keeps: the sequence never goes down, the
// floor is never lowered, the withdrawn list is kept unless told to change, the kernel version never
// goes down. Pure functions; the command wrapper is at the bottom.
export class ManifestError extends Error {
	constructor(message) {
		super(message)
		this.name = 'ManifestError'
	}
}

const fail = (message) => {
	throw new ManifestError(message)
}

export const VERSION = /^\d+\.\d+\.\d+$/
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`)
const TARGET = /^(win32|darwin|linux)-(x64|arm64|ia32)$/
export const DEFAULT_LIFETIME_DAYS = 14

export function compareVersions(a, b) {
	const x = a.split('.').map(Number)
	const y = b.split('.').map(Number)
	for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
	return 0
}

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
const exactKeys = (value, keys, where) => {
	if (!isObject(value)) fail(`${where} is not an object.`)
	const got = Object.keys(value).sort().join()
	if (got !== [...keys].sort().join())
		fail(`${where} has the fields ${got}; expected ${[...keys].sort().join()}.`)
}
const count = (value, where) => {
	if (!Number.isSafeInteger(value) || value < 0) fail(`${where} must be a whole number.`)
}

export const parseTime = (text, where) => {
	if (typeof text !== 'string' || !TIME.test(text) || Number.isNaN(Date.parse(text)))
		fail(`${where} must look like 2026-11-12T10:00:00Z.`)
	return Date.parse(text)
}

/** Strict parse of the manifest bytes: unknown or missing fields are refused. Returns the value. */
export function parseManifest(bytes) {
	let m
	try {
		m = JSON.parse(Buffer.from(bytes).toString('utf8'))
	} catch {
		return fail('The manifest is not valid JSON.')
	}
	exactKeys(
		m,
		[
			'schema',
			'channel',
			'sequence',
			'issuedAt',
			'expiresAt',
			'minimumKernel',
			'withdrawn',
			'kernel',
		],
		'The manifest',
	)
	if (m.schema !== 1) fail('The manifest schema is not 1.')
	if (typeof m.channel !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(m.channel))
		fail('The manifest channel is not a plain lower-case name.')
	if (!Number.isSafeInteger(m.sequence) || m.sequence < 1)
		fail('The manifest sequence must be a whole number of 1 or more.')
	const issued = parseTime(m.issuedAt, 'issuedAt')
	const expires = parseTime(m.expiresAt, 'expiresAt')
	if (expires <= issued) fail('The manifest expires before it is issued.')
	if (!VERSION.test(m.minimumKernel ?? '')) fail('minimumKernel must look like 1.2.3.')
	if (!Array.isArray(m.withdrawn) || m.withdrawn.some((v) => !VERSION.test(v ?? '')))
		fail('withdrawn must be a list of versions like 1.2.3.')
	if (new Set(m.withdrawn).size !== m.withdrawn.length) fail('withdrawn lists a version twice.')
	exactKeys(
		m.kernel,
		['commandLine', 'engine', 'desktopContract', 'dataEpoch', 'bundles'],
		'The manifest kernel',
	)
	if (!VERSION.test(m.kernel.commandLine ?? '')) fail('kernel.commandLine must look like 1.2.3.')
	if (!VERSION.test(m.kernel.engine ?? '')) fail('kernel.engine must look like 1.2.3.')
	for (const key of ['desktopContract', 'dataEpoch'])
		if (!Number.isSafeInteger(m.kernel[key]) || m.kernel[key] < 1)
			fail(`kernel.${key} must be a whole number of 1 or more.`)
	if (!isObject(m.kernel.bundles) || Object.keys(m.kernel.bundles).length === 0)
		fail('The manifest has no bundles.')
	for (const [target, bundle] of Object.entries(m.kernel.bundles)) {
		if (!TARGET.test(target)) fail(`The bundle name "${target}" is not <platform>-<arch>.`)
		exactKeys(
			bundle,
			['file', 'size', 'sha512', 'filesSha512', 'fileCount', 'unpackedSize'],
			`The bundle ${target}`,
		)
		if (
			typeof bundle.file !== 'string' ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bundle.file) ||
			bundle.file.includes('..')
		)
			fail(`The bundle ${target} names a file that is not a bare file name.`)
		for (const key of ['size', 'fileCount', 'unpackedSize'])
			count(bundle[key], `The bundle ${target} ${key}`)
		if (bundle.size < 1) fail(`The bundle ${target} has no size.`)
		for (const key of ['sha512', 'filesSha512'])
			if (typeof bundle[key] !== 'string' || !HEX(128).test(bundle[key]))
				fail(`The bundle ${target} ${key} must be 128 hex digits.`)
	}
	if (compareVersions(m.minimumKernel, m.kernel.commandLine) > 0)
		fail('minimumKernel is above the kernel the manifest offers.')
	// One reading only: a repeated key (JSON.parse keeps the last) or a different layout would let two
	// readers disagree about the signed bytes. The bytes must be what manifestBytes writes.
	if (!Buffer.from(bytes).equals(manifestBytes(m)))
		fail(
			'The manifest is not in the exact form of the text (fields in order, two-space JSON, one newline, no repeated key).',
		)
	return m
}

/** The bundle file name for a command line version and a target. */
export const bundleFileName = (commandLine, target) =>
	`namzu-kernel-${commandLine}-${target}.tar.gz`

const toIso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** The exact bytes of a manifest: two-space JSON and one newline, keys in the order of the text. */
export function manifestBytes(m) {
	const ordered = {
		schema: m.schema,
		channel: m.channel,
		sequence: m.sequence,
		issuedAt: m.issuedAt,
		expiresAt: m.expiresAt,
		minimumKernel: m.minimumKernel,
		withdrawn: m.withdrawn,
		kernel: {
			commandLine: m.kernel.commandLine,
			engine: m.kernel.engine,
			desktopContract: m.kernel.desktopContract,
			dataEpoch: m.kernel.dataEpoch,
			bundles: Object.fromEntries(
				Object.keys(m.kernel.bundles)
					.sort()
					.map((target) => {
						const b = m.kernel.bundles[target]
						return [
							target,
							{
								file: b.file,
								size: b.size,
								sha512: b.sha512,
								filesSha512: b.filesSha512,
								fileCount: b.fileCount,
								unpackedSize: b.unpackedSize,
							},
						]
					}),
			),
		},
	}
	return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`)
}

function timesAndSequence({ issuedAt, lifetimeDays, previous }) {
	const issued = parseTime(issuedAt, 'The issue time')
	if (!(lifetimeDays > 0)) fail('The lifetime must be more than 0 days.')
	const sequence = Math.floor(issued / 1000)
	if (previous && sequence < previous.sequence)
		fail(
			`The sequence ${sequence} (from the issue time ${issuedAt}) is lower than the previous manifest's ${previous.sequence}; a sequence never goes down.`,
		)
	if (previous && sequence === previous.sequence)
		fail(
			`The sequence ${sequence} (from the issue time ${issuedAt}) is not higher than the previous manifest's (it equals it); a later issue time is needed.`,
		)
	return { sequence, issuedAt: toIso(issued), expiresAt: toIso(issued + lifetimeDays * 86400000) }
}

function applyFloorAndWithdrawn({ previous, floor, withdraw = [], unwithdraw = [], commandLine }) {
	for (const v of [...withdraw, ...unwithdraw, ...(floor ? [floor] : [])])
		if (!VERSION.test(v)) fail(`"${v}" is not a version like 1.2.3.`)
	let minimumKernel = previous?.minimumKernel ?? floor ?? commandLine
	if (floor) {
		if (previous && compareVersions(floor, previous.minimumKernel) < 0)
			fail(
				`The floor ${floor} is lower than the previous floor ${previous.minimumKernel}; the floor is never lowered.`,
			)
		minimumKernel = floor
	}
	if (compareVersions(minimumKernel, commandLine) > 0)
		fail(`The floor ${minimumKernel} is above the kernel ${commandLine} being offered.`)
	const withdrawn = new Set(previous?.withdrawn ?? [])
	for (const v of unwithdraw) withdrawn.delete(v)
	for (const v of withdraw) withdrawn.add(v)
	if (withdrawn.has(commandLine))
		fail(`The kernel ${commandLine} being offered is on the withdrawn list.`)
	return { minimumKernel, withdrawn: [...withdrawn].sort(compareVersions) }
}

/**
 * Assemble a new manifest. `entries` are the outputs of the pack step: `{ target, kernel: {commandLine,
 * engine, desktopContract, dataEpoch}, bundle }`. All must describe the same kernel. `previous` is the
 * parsed previous manifest, when there is one.
 */
export function assembleManifest({
	entries,
	channel = 'latest',
	issuedAt,
	lifetimeDays = DEFAULT_LIFETIME_DAYS,
	floor,
	withdraw,
	unwithdraw,
	previous,
}) {
	if (!entries || entries.length === 0) fail('At least one bundle entry is needed.')
	const kernel = entries[0].kernel
	for (const entry of entries)
		for (const key of ['commandLine', 'engine', 'desktopContract', 'dataEpoch'])
			if (entry.kernel[key] !== kernel[key])
				fail(
					`The bundle entries disagree about ${key}: ${entry.kernel[key]} for ${entry.target}, ${kernel[key]} for ${entries[0].target}.`,
				)
	if (previous && previous.channel !== channel)
		fail(`The previous manifest is for the channel "${previous.channel}", not "${channel}".`)
	if (previous) {
		const order = compareVersions(kernel.commandLine, previous.kernel.commandLine)
		if (order < 0)
			fail(
				`The kernel ${kernel.commandLine} is older than the one in the previous manifest, ${previous.kernel.commandLine}.`,
			)
		if (order === 0)
			fail(
				`The kernel ${kernel.commandLine} is the one the previous manifest already offers; use reissue to renew it.`,
			)
	}
	const bundles = {}
	for (const entry of entries) {
		if (!TARGET.test(entry.target)) fail(`"${entry.target}" is not <platform>-<arch>.`)
		if (bundles[entry.target]) fail(`The target ${entry.target} is given twice.`)
		bundles[entry.target] = {
			...entry.bundle,
			file: bundleFileName(kernel.commandLine, entry.target),
		}
	}
	const manifest = {
		schema: 1,
		channel,
		...timesAndSequence({ issuedAt, lifetimeDays, previous }),
		...applyFloorAndWithdrawn({
			previous,
			floor,
			withdraw,
			unwithdraw,
			commandLine: kernel.commandLine,
		}),
		kernel: { ...kernel, bundles },
	}
	// Field order and shape are fixed by manifestBytes; a parse proves the result is one a reader accepts.
	return parseManifest(manifestBytes(manifest))
}

/**
 * Re-issue the previous manifest with new times and a higher sequence. The kernel and its bundles are
 * unchanged; the floor may be raised and the withdrawn list changed by the same rules as above.
 */
export function reissueManifest({
	previous,
	issuedAt,
	lifetimeDays = DEFAULT_LIFETIME_DAYS,
	floor,
	withdraw,
	unwithdraw,
}) {
	if (!previous) fail('A re-issue needs the previous manifest.')
	const times = timesAndSequence({ issuedAt, lifetimeDays, previous })
	if (times.sequence <= previous.sequence)
		fail(
			`The new sequence ${times.sequence} is not higher than the previous ${previous.sequence}; a re-issue needs a later issue time.`,
		)
	return parseManifest(
		manifestBytes({
			...previous,
			...times,
			...applyFloorAndWithdrawn({
				previous,
				floor,
				withdraw,
				unwithdraw,
				commandLine: previous.kernel.commandLine,
			}),
		}),
	)
}
