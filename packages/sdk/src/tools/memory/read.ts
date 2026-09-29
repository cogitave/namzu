import { z } from 'zod'
import {
	MEMORY_VERIFY_NOTICE,
	describeMemoryAge,
	memoryLinkNames,
} from '../../store/memory/links.js'
import { MemoryRevisionUnavailableError } from '../../store/memory/revision.js'
import type { MemoryId } from '../../types/ids/index.js'
import type { MemoryContent, MemoryIndexEntry, MemoryStore } from '../../types/memory/index.js'
import { hasConditionalMemoryWrites } from '../../types/memory/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { allMemoryEntries, resolveMemoryReference } from './resolve.js'

export function buildReadMemoryTool(store: MemoryStore): ToolDefinition {
	return defineTool({
		name: 'read_memory',
		description:
			'Read the full content of a specific memory by its ID or its name. For a text or Markdown memory the result ends with how old the memory is and resolves any [[name]] links it contains.',
		inputSchema: z.object({
			id: z
				.string()
				.describe(
					'Opaque memory ID returned by a memory search or save, or the memory name from the index',
				),
		}),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute({ id }) {
			// Validate model-authored input before using it as a store key. A name
			// is resolved through the store's own listing, never used as a key.
			const reference = await resolveMemoryReference(store, id)
			if (!reference.found) {
				return {
					success: false,
					output: `No memory is named ${id}.`,
					error: `Memory ${id} not found`,
				}
			}
			const memoryId: MemoryId = reference.id
			let entries: readonly MemoryIndexEntry[] | undefined = reference.entries

			let entry: MemoryIndexEntry | undefined
			let content: MemoryContent | undefined
			let revision: string | undefined
			if (hasConditionalMemoryWrites(store)) {
				try {
					const record = await store.getVersionedRecord(memoryId)
					entry = record?.entry
					content = record?.content
					revision = record?.revision
				} catch (error) {
					if (!(error instanceof MemoryRevisionUnavailableError)) throw error
					// Legacy in-memory records may hold cloneable host objects with
					// inaccessible bytes. Read them without claiming CAS support.
					const record = await store.getRecord?.(memoryId)
					entry = record?.entry
					content = record?.content ?? (await store.get(memoryId))
				}
			} else if (store.getRecord) {
				const record = await store.getRecord(memoryId)
				entry = record?.entry
				content = record?.content
			} else {
				content = await store.get(memoryId)
			}

			if (!content) {
				return {
					success: false,
					output: `Memory ${id} not found.`,
					error: `Memory ${id} not found`,
				}
			}

			const notes: string[] = []
			if (entry) {
				const age = describeMemoryAge(entry.updatedAt)
				notes.push(
					`Last updated ${new Date(entry.updatedAt).toISOString().slice(0, 10)} (${age})${
						entry.type ? `; type ${entry.type}` : ''
					}${entry.status === 'archived' ? '; archived' : ''}.`,
				)
				if (age !== 'today') notes.push(MEMORY_VERIFY_NOTICE)
			}
			const links = memoryLinkNames(content.content)
			const resolved: { name: string; id?: MemoryId; description?: string }[] = []
			if (links.length > 0) {
				entries ??= await allMemoryEntries(store)
				notes.push('Linked memories:')
				for (const name of links) {
					const target = entries.find((candidate) => candidate.name === name)
					resolved.push({
						name,
						...(target ? { id: target.id } : {}),
						...(target ? { description: target.description ?? target.summary } : {}),
					})
					notes.push(
						target
							? `- [[${name}]] → ${target.id}${target.status === 'archived' ? ' (archived)' : ''} — ${target.description ?? target.summary}`
							: `- [[${name}]] → no memory has this name`,
					)
				}
			}

			// A JSON body stays exactly the stored text, parseable as it was
			// before these notes existed; its age and links are in `data`.
			const annotate = notes.length > 0 && content.format !== 'json'
			const output = annotate ? `${content.content}\n\n---\n${notes.join('\n')}` : content.content
			return {
				success: true,
				output,
				// The executor sends output or content to the model, not data. Keep
				// output byte-compatible (including JSON) while exposing the token
				// in a separate model-visible text block.
				...(revision !== undefined
					? {
							content: [
								{ type: 'text' as const, text: output },
								{
									type: 'text' as const,
									text: `Memory revision: ${revision}. Pass it as revision to update_memory or delete_memory to reject stale changes.`,
								},
							],
						}
					: {}),
				data: {
					id: content.id,
					format: content.format,
					metadata: content.metadata,
					...(entry?.name !== undefined ? { name: entry.name } : {}),
					...(entry?.type !== undefined ? { type: entry.type } : {}),
					...(entry ? { updatedAt: entry.updatedAt } : {}),
					...(revision !== undefined ? { revision } : {}),
					...(resolved.length > 0 ? { links: resolved } : {}),
				},
			}
		},
	})
}
