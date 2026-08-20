import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ToolContext, ToolResult } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { resolveWithinReal } from '../paths.js'
import { atomicWriteFile } from './atomic-write-file.js'
import { fingerprintContent, staleFileError } from './content-fingerprint.js'
import { withFileMutationLock } from './file-mutation-lock.js'

const inputSchema = z
	.object({
		path: z
			.string()
			.min(1)
			// `.min(1)` alone admits `"   "`, which resolves to the working
			// directory itself and turns a write into a directory-write error
			// nobody can read. `edit` has refused this since it was written;
			// the two tools disagreeing on the same input is the kind of gap a
			// model finds and a reviewer does not.
			.refine((value) => value.trim().length > 0, 'Path must not be empty.')
			.describe(
				'Relative path to the file to write (e.g. "outputs/report.md"). Required. Must be a non-empty string.',
			),
		content: z
			.string()
			.optional()
			.describe(
				'Full file body to write. Required (use "" only for an intentionally empty file). The file is fully overwritten — pass the COMPLETE intended content for this bounded chunk, not a diff. Self-budget content under 12000 characters before calling; if the intended body is longer, write a smaller opening section here, then use `edit` with insertLine: "end" to extend the file section by section. Do NOT try to chain multiple `write` calls, since each one overwrites the previous.',
			),
		newStr: z
			.string()
			.optional()
			.describe(
				'Alias for content. Useful for hosts that expose create/write operations as newStr. Self-budget this payload under 12000 characters before calling.',
			),
	})
	.strict()
	.refine((value) => typeof value.content === 'string' || typeof value.newStr === 'string', {
		message: 'Either content or newStr is required.',
	})

type WriteInput = z.infer<typeof inputSchema>

/**
 * The single shape a model is constrained to emit.
 *
 * `newStr` is a host affordance and deliberately absent here: a model given
 * two names for the body has to pick, and picking is what produces the
 * half-filled calls this schema exists to prevent.
 */
const modelInputSchema: Record<string, unknown> = {
	type: 'object',
	properties: {
		path: {
			type: 'string',
			description: 'Relative path to the file to write. Must not be empty.',
		},
		content: {
			type: 'string',
			description:
				'Complete file body. Use "" only for an intentionally empty file. Keep under 12000 characters.',
		},
	},
	required: ['path', 'content'],
	additionalProperties: false,
}

export const WriteFileTool = defineTool({
	name: 'write',
	description:
		'Writes a file to the local filesystem. Overwrites the existing file at the path if there is one.\n\n- If the file already exists, you must use the `read` tool on it first in this conversation, or this call will fail.\n- Prefer the `edit` tool for modifying existing files — it only sends the diff and preserves the rest of the file byte-for-byte.\n- Use `write` to create a new file or to perform a deliberate full rewrite of a file you have already read.\n- Self-budget content/newStr under 12000 characters before emitting the tool call. For long content, write a smaller opening section, then use `edit` with insertLine: "end" to extend the file section by section. Do not chain multiple `write` calls — each one overwrites the previous.',
	inputSchema,
	modelInputSchema,
	enforceModelInput: true,
	validationErrorHint:
		'Required shape: {"path":"file.md","content":"complete file body"}. Pass the whole body, not a diff.',
	category: 'filesystem',
	permissions: ['file_write'],
	readOnly: false,
	destructive: true,
	concurrencySafe: false,

	/**
	 * The whole file body, described by the tool.
	 *
	 * A `diff` with an EMPTY `before`, which is what a write actually is:
	 * whatever was there is gone and this is what replaces it. `edit`
	 * declines to do that for an insert — there, an empty `before` would
	 * claim the whole file was added and it was not. Here it is true.
	 *
	 * A host with nothing to contrast against renders the `after` plainly
	 * rather than as `+` lines, which is the row a reader wants: they are
	 * approving a file, not reviewing a patch.
	 */
	presentCall(input: WriteInput) {
		const content = input.content ?? input.newStr
		if (typeof content !== 'string') return undefined
		return {
			kind: 'diff' as const,
			...(input.path ? { path: input.path } : {}),
			before: '',
			after: content,
		}
	},

	/**
	 * A label, deliberately — which is what suppresses the detail block.
	 *
	 * The content was already shown under the CALL, where the user could
	 * act on it. Repeating it under the result doubles the longest rows in
	 * the transcript to say nothing new. A host used to decide this by
	 * matching `name === 'write' || name === 'edit'`; it is the tool's to
	 * say, and now it says it.
	 */
	presentResult(_input: WriteInput, result: ToolResult) {
		return { kind: 'generic' as const, label: result.output?.split('\n')[0] ?? '' }
	},

	async execute(input: WriteInput, context) {
		// `execute` is reachable without going through the registry, so the
		// closed contract has to be enforced on this path too or it is not
		// closed at all.
		const parsed = inputSchema.safeParse(input)
		if (!parsed.success) {
			return {
				success: false,
				output: '',
				error: `Invalid write input: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
			}
		}
		const valid = parsed.data
		const content = valid.content ?? valid.newStr ?? ''
		// Host-side containment, on the host branch only. The sandbox has its
		// own root and its own resolver; canonicalizing a sandbox-relative
		// path against the HOST filesystem asks a question about the wrong
		// machine and answers it with whatever happens to exist there.
		const filePath = context.sandbox
			? undefined
			: await resolveWithinReal(context.workingDirectory, valid.path)
		// The exists-check and the write are a check-then-act pair. Unlocked,
		// two writers both see "absent", both skip the read-before-overwrite
		// guard, and the second silently discards the first.
		const lockKey = context.sandbox ? `sandbox:${valid.path}` : `local:${filePath as string}`

		return withFileMutationLock(lockKey, async () => {
			if (context.sandbox) {
				const current = await readSandboxFileIfPresent(context, valid.path)
				if (current !== undefined) {
					const guard = enforceFreshOverwrite(context, valid.path, current.toString('utf-8'))
					if (guard) return guard
				}
				await context.sandbox.writeFile(valid.path, content)
				// This write is now the runtime's newest observation. Recording only
				// the boolean would leave an older content fingerprint in place and
				// make the next same-run write refuse its own predecessor as drift.
				context.fileReadTracker?.recordRead(valid.path, content)
				return {
					success: true as const,
					output: `File written successfully: ${valid.path} (${content.length} chars) [sandboxed]`,
					data: { path: valid.path, size: content.length, sandboxed: true },
				}
			}

			const hostPath = filePath as string
			const current = await readHostFileIfPresent(hostPath)
			if (current !== undefined) {
				const guard = enforceFreshOverwrite(context, hostPath, current)
				if (guard) return guard
			}

			await mkdir(dirname(hostPath), { recursive: true })
			// Temp file, fsync, rename. A plain write that fails partway
			// leaves the destination truncated — and this tool overwrites a
			// whole file, so the truncation is the user's previous work.
			await atomicWriteFile(hostPath, content)
			context.fileReadTracker?.recordRead(hostPath, content)

			return {
				success: true as const,
				output: `File written successfully: ${hostPath} (${content.length} chars)`,
				data: { path: hostPath, size: content.length },
			}
		})
	},
})

function enforceReadBeforeOverwrite(
	context: ToolContext,
	key: string,
): { success: false; output: ''; error: string } | null {
	if (!context.fileReadTracker) return null
	if (context.fileReadTracker.hasRead(key)) return null
	return {
		success: false,
		output: '',
		error: `${key} already exists. Use the \`read\` tool on it first in this conversation, then call \`write\` again — or prefer \`edit\` for a targeted change.`,
	}
}

function enforceFreshOverwrite(
	context: ToolContext,
	key: string,
	currentContent: string,
): { success: false; output: ''; error: string } | null {
	const unread = enforceReadBeforeOverwrite(context, key)
	if (unread) return unread

	// Optional forever: older hosts only tracked the boolean read-before-write
	// fact. They retain their old behavior rather than being refused on a
	// fingerprint the host never promised to capture.
	const observed = context.fileReadTracker?.fingerprint?.(key)
	if (observed !== undefined && observed !== fingerprintContent(currentContent)) {
		return { success: false, output: '', error: staleFileError(key, 'write') }
	}
	return null
}

async function readHostFileIfPresent(hostPath: string): Promise<string | undefined> {
	try {
		return await readFile(hostPath, 'utf-8')
	} catch (error) {
		if (isMissingFileError(error)) return undefined
		throw error
	}
}

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === 'ENOENT'
	)
}

async function readSandboxFileIfPresent(
	context: ToolContext,
	path: string,
): Promise<Buffer | undefined> {
	if (!context.sandbox) return undefined
	try {
		return await context.sandbox.readFile(path)
	} catch {
		// `Sandbox` currently has no typed missing-file result. Preserve the
		// existing create behavior for all backends; when a read succeeds, the
		// exact body above is still a real admission-time freshness check.
		return undefined
	}
}
