import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { z } from 'zod'
import { admitMcpImageBatch } from '../connector/mcp/image-admission.js'
import { defineTool } from '../tools/defineTool.js'
import type { MessageAttachment } from '../types/message/index.js'
import type { Sandbox } from '../types/sandbox/index.js'
import type { ToolContext, ToolDefinition } from '../types/tool/index.js'

const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 3 * 1024 * 1024
const MAX_BATCH_BYTES = 12 * 1024 * 1024
const EXTENSIONS: Readonly<Record<string, string>> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
}

/** Validated inline image bytes, captured from one current operator input. */
export interface PalReferenceImage {
	/** One-based position in the original attachment array, including non-image attachments. */
	readonly attachmentIndex: number
	readonly mediaType: string
	readonly data: string
	readonly sha256: string
	readonly bytes: number
}

/** Confirmed guest file; never a suggested path or a host filename. */
export interface PalReferenceImageImportReceipt {
	readonly attachmentIndex: number
	readonly mediaType: string
	readonly sha256: string
	readonly bytes: number
	readonly path: string
}

export interface PalReferenceImageImportOptions {
	readonly sandbox: Sandbox
	/** Reread pause, takeover, generation and current authority before every guest operation. */
	readonly assertCurrentAdmission: () => void | Promise<void>
	readonly signal?: AbortSignal
}

export interface PalReferenceImageToolOptions {
	/** Host-captured current input only; never a model-selected host path or history search. */
	readonly attachments: () => readonly MessageAttachment[]
	readonly assertCurrentAdmission: (context: ToolContext) => void | Promise<void>
}

/**
 * Validate a complete reference batch before allocating or writing any guest file.
 * URLs and stored references need a host-owned resolver; this API never fetches them.
 */
export function preparePalReferenceImages(
	attachments: readonly MessageAttachment[],
): readonly PalReferenceImage[] {
	const references: PalReferenceImage[] = []
	let total = 0
	for (const [index, attachment] of attachments.entries()) {
		if (attachment.type === 'document') continue
		if (attachment.type === 'stored') {
			if (attachment.kind === 'image')
				throw new Error(
					'Stored image references require an explicit host-owned resolver before guest import.',
				)
			continue
		}
		if (attachment.type !== undefined && attachment.type !== 'image')
			throw new Error('Unsupported reference attachment type.')
		if (references.length >= MAX_IMAGES)
			throw new Error(`Reference import allows at most ${MAX_IMAGES} images per input.`)
		if (
			typeof attachment.data !== 'string' ||
			attachment.data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)
		)
			throw new Error(`Each reference image must fit within ${MAX_IMAGE_BYTES} bytes.`)
		if (
			!EXTENSIONS[attachment.mediaType] ||
			!admitMcpImageBatch([
				{
					type: 'image',
					data: attachment.data,
					mimeType: attachment.mediaType,
				},
			])
		)
			throw new Error(`Reference attachment ${index + 1} is not a complete supported raster image.`)
		const bytes = Buffer.from(attachment.data, 'base64')
		total += bytes.length
		if (bytes.length > MAX_IMAGE_BYTES || total > MAX_BATCH_BYTES)
			throw new Error(`Reference images must fit within ${MAX_BATCH_BYTES} bytes per input.`)
		references.push(
			Object.freeze({
				attachmentIndex: index + 1,
				mediaType: attachment.mediaType,
				data: attachment.data,
				sha256: createHash('sha256').update(bytes).digest('hex'),
				bytes: bytes.length,
			}),
		)
	}
	return Object.freeze(references)
}

// The shipped Pal guest has Python 3. All I/O below occurs through the admitted
// sandbox; a missing guest interpreter fails rather than running anything locally.
// Directory descriptors and O_NOFOLLOW protect the reference store from symlinks;
// link() publishes a new file exclusively and never replaces an existing reference.
const IMPORT_SCRIPT = String.raw`
import fcntl, hashlib, json, os, stat, sys
request = json.loads(sys.argv[1])
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
root = os.open(request['root'], flags)
def directory(parent, name):
    try: os.mkdir(name, 0o700, dir_fd=parent)
    except FileExistsError: pass
    return os.open(name, flags, dir_fd=parent)
store = directory(root, '.namzu')
refs = directory(store, 'references')
imports = directory(store, 'reference-imports')
lock = os.open('.reference-lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=store)
if not stat.S_ISREG(os.fstat(lock).st_mode): raise RuntimeError('Reference lock is not a regular file')
fcntl.flock(lock, fcntl.LOCK_EX)
def verify(parent, name, item):
    try: fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError: return False
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != item['bytes']:
            raise RuntimeError('Reference file collision or invalid staging file')
        if hashlib.sha256(file.read(item['bytes'] + 1)).hexdigest() != item['sha256']:
            raise RuntimeError('Reference file collision or invalid staging bytes')
    return True
phase = request['phase']
items = request['items']
name = request['operation']
if phase == 'preflight':
    missing = [item['name'] for item in items if not verify(refs, item['name'], item)]
    if missing: os.mkdir(name, 0o700, dir_fd=imports)
    print(json.dumps(missing))
else:
    stage = os.open(name, flags, dir_fd=imports)
    try:
        if phase == 'commit':
            missing = []
            for item in items:
                if not verify(refs, item['name'], item):
                    if not verify(stage, item['name'], item): raise RuntimeError('Reference staging file is absent')
                    missing.append(item)
            created = []
            try:
                for item in missing:
                    os.link(item['name'], item['name'], src_dir_fd=stage, dst_dir_fd=refs, follow_symlinks=False)
                    created.append(item['name'])
                    fd = os.open(item['name'], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=refs)
                    try: os.fchmod(fd, 0o444); os.fsync(fd)
                    finally: os.close(fd)
                    if not verify(refs, item['name'], item): raise RuntimeError('Published reference file is absent')
                os.fsync(refs)
            except BaseException:
                for created_name in created: os.unlink(created_name, dir_fd=refs)
                raise
            print('references-ready')
        elif phase != 'cleanup': raise RuntimeError('Unsupported reference import phase')
    finally:
        for entry in os.listdir(stage): os.unlink(entry, dir_fd=stage)
        os.close(stage)
        os.rmdir(name, dir_fd=imports)
`

/**
 * Import validated originals into content-addressed guest files without overwriting.
 * Read-only mode must be enforced by the embedding host before calling this writer.
 */
export async function importPalReferenceImages(
	references: readonly PalReferenceImage[],
	options: PalReferenceImageImportOptions,
): Promise<readonly PalReferenceImageImportReceipt[]> {
	if (!options.sandbox || typeof options.assertCurrentAdmission !== 'function')
		throw new TypeError('Reference import requires a sandbox and a current admission check.')
	const root = options.sandbox.rootDir
	if (!posix.isAbsolute(root) || root === '/' || root.includes('\\') || root.includes('\0'))
		throw new Error('Reference import requires an owned POSIX guest working directory.')
	// Public JavaScript callers cannot forge a prepared object to choose a filename
	// or bypass image bounds. Recompute every digest and preserve only its position.
	const verified = preparePalReferenceImages(
		references.map((reference) => ({
			type: 'image' as const,
			mediaType: reference.mediaType,
			data: reference.data,
		})),
	).map((reference, index) => {
		const original = references[index]
		if (
			!original ||
			!Number.isSafeInteger(original.attachmentIndex) ||
			original.attachmentIndex < 1 ||
			original.sha256 !== reference.sha256 ||
			original.bytes !== reference.bytes
		)
			throw new Error('Reference image metadata does not match its original bytes.')
		return { ...reference, attachmentIndex: original.attachmentIndex }
	})
	if (verified.length === 0) return []
	const operation = randomUUID()
	const entries = new Map(
		verified.map((reference) => [
			`${reference.sha256}.${EXTENSIONS[reference.mediaType]}`,
			reference,
		]),
	)
	const items = [...entries].map(([name, reference]) => ({
		name,
		sha256: reference.sha256,
		bytes: reference.bytes,
	}))
	const assertCurrent = async () => {
		options.signal?.throwIfAborted()
		await options.assertCurrentAdmission()
		options.signal?.throwIfAborted()
	}
	const execute = async (phase: 'preflight' | 'commit' | 'cleanup') => {
		await assertCurrent()
		const result = await options.sandbox.exec(
			'python3',
			['-c', IMPORT_SCRIPT, JSON.stringify({ phase, root, operation, items })],
			{ signal: options.signal },
		)
		await assertCurrent()
		if (result.exitCode !== 0 || result.timedOut || result.signal)
			throw new Error(`Guest reference import ${phase} failed; no manifest was published.`)
		return result.stdout.trim()
	}
	const output = await execute('preflight')
	const missing: unknown = JSON.parse(output)
	if (
		!Array.isArray(missing) ||
		missing.some((name) => typeof name !== 'string' || !entries.has(name))
	)
		throw new Error('The guest returned an invalid reference import preflight.')
	if (missing.length > 0) {
		let committed = false
		try {
			for (const name of new Set(missing as string[])) {
				await assertCurrent()
				const reference = entries.get(name)
				if (!reference) throw new Error('The guest requested an unknown reference.')
				await options.sandbox.writeFile(
					posix.join(root, '.namzu', 'reference-imports', operation, name),
					Buffer.from(reference.data, 'base64'),
				)
				await assertCurrent()
			}
			if ((await execute('commit')) !== 'references-ready')
				throw new Error('The guest did not confirm reference publication.')
			committed = true
		} finally {
			// A revoked admission never authorizes another operation merely for cleanup.
			// An interrupted scratch directory can remain, but is never a reference receipt.
			if (!committed && !options.signal?.aborted) {
				try {
					await execute('cleanup')
				} catch {
					// Preserve the original import failure; guest teardown owns remaining scratch.
				}
			}
		}
	}
	return Object.freeze(
		verified.map(({ data: _data, ...reference }) =>
			Object.freeze({
				...reference,
				path: posix.join(
					root,
					'.namzu',
					'references',
					`${reference.sha256}.${EXTENSIONS[reference.mediaType]}`,
				),
			}),
		),
	)
}

/** Explicit writer that passes through the ordinary tool permission/review policy. */
export function createPalReferenceImageTool(options: PalReferenceImageToolOptions): ToolDefinition {
	return defineTool({
		name: 'import_reference_images',
		description:
			'Copy the original inline reference images attached to the current operator input into this Pal computer for use by any application. Takes no filenames, URLs or base64. Returns a verified attachment-position-to-guest-file manifest only after the original bytes exist there. Existing matching references are reused and never overwritten. Stored references need a host resolver. An attachment visible to the model is not yet a guest file; call this tool before using it in an application. Requires permission to write files.',
		inputSchema: z.object({}).strict(),
		category: 'filesystem',
		permissions: ['file_write'],
		readOnly: false,
		destructive: false,
		concurrencySafe: false,
		maxRetries: 0,
		async execute(_input, context) {
			if (!context.sandbox)
				throw new Error('Reference images can only be imported into an admitted Pal computer.')
			if (context.permissionContext?.mode === 'plan')
				throw new Error(
					'Reference image import writes files and is unavailable in read-only plan mode.',
				)
			await options.assertCurrentAdmission(context)
			const references = preparePalReferenceImages(options.attachments())
			if (references.length === 0)
				throw new Error('The current operator input has no inline reference images to import.')
			const receipt = await importPalReferenceImages(references, {
				sandbox: context.sandbox,
				assertCurrentAdmission: () => options.assertCurrentAdmission(context),
				signal: context.abortSignal,
			})
			return {
				success: true,
				output: JSON.stringify({ references: receipt }),
				data: { references: receipt },
			}
		},
	})
}
