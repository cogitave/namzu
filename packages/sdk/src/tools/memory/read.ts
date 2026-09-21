import { z } from 'zod'
import {
	MEMORY_VERIFY_NOTICE,
	describeMemoryAge,
	memoryLinkNames,
} from '../../store/memory/links.js'
import { isMemoryName } from '../../store/memory/naming.js'
import type { MemoryId } from '../../types/ids/index.js'
import type { MemoryContent, MemoryIndexEntry, MemoryStore } from '../../types/memory/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { asMemoryId, isEntityId } from '../../utils/id.js'
import { defineTool } from '../defineTool.js'

/** Every record, archived included, for resolving names. One store read. */
async function allEntries(store: MemoryStore): Promise<readonly MemoryIndexEntry[]> {
	return (await store.list({})).entries
}

export function buildReadMemoryTool(store: MemoryStore): ToolDefinition {
	return defineTool({
		name: 'read_memory',
		description:
			'Read the full content of a specific memory by its ID or its name. The result says how old the memory is and resolves any [[name]] links it contains.',
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
			let entries: readonly MemoryIndexEntry[] | undefined
			let memoryId: MemoryId
			if (isEntityId(id, 'memory')) {
				memoryId = asMemoryId(id)
			} else if (isMemoryName(id)) {
				entries = await allEntries(store)
				const named = entries.find((entry) => entry.name === id)
				if (!named) {
					return {
						success: false,
						output: `No memory is named ${id}.`,
						error: `Memory ${id} not found`,
					}
				}
				memoryId = named.id
			} else {
				memoryId = asMemoryId(id)
			}

			let entry: MemoryIndexEntry | undefined
			let content: MemoryContent | undefined
			if (store.getRecord) {
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
				entries ??= await allEntries(store)
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

			return {
				success: true,
				output:
					notes.length > 0 ? `${content.content}\n\n---\n${notes.join('\n')}` : content.content,
				data: {
					id: content.id,
					format: content.format,
					metadata: content.metadata,
					...(entry?.name !== undefined ? { name: entry.name } : {}),
					...(entry?.type !== undefined ? { type: entry.type } : {}),
					...(entry ? { updatedAt: entry.updatedAt } : {}),
					...(resolved.length > 0 ? { links: resolved } : {}),
				},
			}
		},
	})
}
