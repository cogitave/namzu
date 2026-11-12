import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { DATA_EPOCH } from '../constants/data-epoch.js'

/**
 * The guard behind `DATA_EPOCH`.
 *
 * Every on-disk format the engine stamps with a version is listed here with its
 * current version. A version that changes, appears or disappears fails this
 * test, so changing what an older engine would meet on disk is a decision that
 * has a name. The inventory these rows belong to, including the formats that
 * carry no stamp, is `docs/sdk/kernel-facts.md`.
 *
 * What the scan covers: every `const …VERSION… = <integer>`, every
 * `defineSchema({ kind, current })`, and the literal stamps in `LITERAL_STAMPS`
 * below. A format stamped some other way is not seen by the scan; add it to
 * `LITERAL_STAMPS` when you find one.
 */

const RULE = [
	'RULE: raise DATA_EPOCH (packages/sdk/src/constants/data-epoch.ts) when an older engine can no longer',
	'safely read or write what this one writes (it would refuse the file, drop fields it does not know and',
	'write them back without, or misread it). Raising it means an installed desktop application stops using',
	'this engine until the application itself is updated, so do it only when it is true.',
	'Otherwise (an older engine reads and writes the new form the same way, or ignores it) record the new',
	'value in this table and say why in the same commit. The inventory is docs/sdk/kernel-facts.md.',
].join('\n')

const RECORDED_DATA_EPOCH = 1

/** `file#NAME` of a version constant, with its value. `onDisk` false: a protocol or contract number, not a file. */
const CONSTANTS: Record<string, { version: number; onDisk: boolean }> = {
	'account/registry.ts#ACCOUNTS_FILE_VERSION': { version: 1, onDisk: true },
	'constants/acp/index.ts#ACP_PROTOCOL_VERSION': { version: 1, onDisk: false },
	'learning/experience-store.ts#LEARNING_EXPERIENCE_STORE_VERSION': { version: 1, onDisk: true },
	'learning/store.ts#LEARNING_STORE_VERSION': { version: 3, onDisk: true },
	'peers/record.ts#PEER_RECORD_VERSION': { version: 1, onDisk: true },
	'provider/conformance.ts#PROVIDER_DRIVER_CONTRACT_VERSION': { version: 1, onDisk: false },
	'runtime/query/turn/outcome-ledger.ts#SNAPSHOT_VERSION': { version: 1, onDisk: true },
	'store/budget/ledger.ts#SESSION_TOKEN_BUDGET_VERSION': { version: 2, onDisk: true },
	'store/schema.ts#INITIAL_SCHEMA_VERSION': { version: 1, onDisk: false },
	'store/session-index/sqlite.ts#SESSION_INDEX_VERSION': { version: 1, onDisk: true },
	'store/session-log/conformance.ts#SESSION_LOG_CONTRACT_VERSION': { version: 2, onDisk: false },
	'types/session/checkpoint.ts#CHECKPOINT_DOCUMENT_VERSION': { version: 1, onDisk: true },
	'types/session/records.ts#SESSION_RECORD_SCHEMA_VERSION': { version: 1, onDisk: true },
	'types/session/turn-state.ts#TURN_STATE_VERSION': { version: 1, onDisk: true },
}

/** Records stamped through `defineSchema` (field `schemaVersion`): `kind` and the current version. */
const SCHEMAS: Record<string, number> = {
	'feedback-store': 1,
	'learning-guidance': 1,
	'markdown-memory': 1,
	'memory-store': 1,
	'pal-activity-subscription': 1,
	'pal-activity-subscription-permission': 1,
	'pal-channel-route': 1,
	'pal-communication': 2,
	'pal-message-operation': 2,
	'pal-message-permission': 1,
	'resident-agenda': 6,
	'session-goal': 2,
	'session-store': 4,
	'task-store': 2,
	'topic-objective': 1,
	'topic-state': 1,
}

/** Stamps written as a literal in a type or a validator. `pattern` has one capture group: the version. */
const LITERAL_STAMPS: { format: string; file: string; pattern: RegExp; version: number }[] = [
	{
		format: 'project document (project.json)',
		file: 'session/paths.ts',
		pattern: /v: (\d+),\s*kind: 'project'/,
		version: 1,
	},
	{
		format: 'child session meta record (subagents/<child-id>.meta.json)',
		file: 'types/session/records.ts',
		pattern: /v: z\.literal\((\d+)\),\s*kind: z\.literal\('child-session'\)/,
		version: 1,
	},
	{
		format: 'session lease document (lease.json)',
		file: 'store/session-log/lease.ts',
		pattern: /v: (\d+),\s*kind: 'lease'/,
		version: 1,
	},
	{
		format: 'session log spill manifest',
		file: 'store/session-log/spill.ts',
		pattern: /readonly v: (\d+)\s*readonly kind: 'spill'/,
		version: 1,
	},
	{
		format: 'tool result spill manifest',
		file: 'store/evidence/format.ts',
		pattern: /export interface SpillManifest \{\s*version: (\d+)/,
		version: 1,
	},
	{
		format: 'harness session journal record',
		file: 'types/harness/schema.ts',
		pattern: /v: z\.literal\((\d+)\)/,
		version: 1,
	},
	{
		format: 'pal definition revision',
		file: 'pals/store.ts',
		pattern: /raw\.v !== (\d+)/,
		version: 1,
	},
	{
		format: 'pal communication policy',
		file: 'pals/communication/policy.ts',
		pattern: /v: z\.literal\((\d+)\)/,
		version: 1,
	},
	{
		format: 'pal activity source cursor',
		file: 'pals/activity/source.ts',
		pattern: /v: z\.literal\((\d+)\)/,
		version: 1,
	},
	{
		format: 'pal channel record',
		file: 'pals/channels/schema.ts',
		pattern: /v: z\.literal\((\d+)\)/,
		version: 1,
	},
	{
		format: 'pal ingress record',
		file: 'pals/communication/ingress-schema.ts',
		pattern: /v: z\.literal\((\d+)\)/,
		version: 1,
	},
	{
		format: 'shared session workspace manifest',
		file: 'types/workspace/shared-session.ts',
		pattern: /schemaVersion: (\d+)\s*kind: 'shared-session-workspace'/,
		version: 1,
	},
	{
		format: 'persona record',
		file: 'types/persona/index.ts',
		pattern: /schemaVersion: (\d+)/,
		version: 1,
	},
]

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function sources(dir: string): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) {
			if (entry.name === '__tests__' || entry.name === '__fixtures__') continue
			out.push(...sources(path))
		} else if (
			entry.name.endsWith('.ts') &&
			!entry.name.endsWith('.test.ts') &&
			!entry.name.endsWith('.proc-test.ts')
		) {
			out.push(path)
		}
	}
	return out
}

const files = sources(SRC).map((path) => ({
	name: relative(SRC, path).split('\\').join('/'),
	text: readFileSync(path, 'utf8'),
}))

function differences(recorded: Record<string, number>, found: Record<string, number>): string[] {
	const out: string[] = []
	for (const [key, version] of Object.entries(found)) {
		if (!(key in recorded)) out.push(`added: ${key} = ${version}`)
		else if (recorded[key] !== version) out.push(`changed: ${key} ${recorded[key]} -> ${version}`)
	}
	for (const key of Object.keys(recorded)) {
		if (!(key in found)) out.push(`removed or no longer found: ${key}`)
	}
	return out
}

describe('data epoch guard', () => {
	it('records the epoch itself, so raising it is a visible edit', () => {
		expect(Number.isInteger(DATA_EPOCH) && DATA_EPOCH >= 1).toBe(true)
		expect(
			DATA_EPOCH,
			`DATA_EPOCH is ${DATA_EPOCH}, recorded ${RECORDED_DATA_EPOCH}. Record the new value here and in the desktop contract inventory notes if this was on purpose.\n${RULE}`,
		).toBe(RECORDED_DATA_EPOCH)
	})

	it('knows every version constant', () => {
		const found: Record<string, number> = {}
		const pattern =
			/^\s*(?:export )?const ((?:[A-Z0-9]+_)*VERSION(?:_[A-Z0-9]+)*)(?::\s*\w+)? = (\d+)(?: as const)?\s*$/gm
		for (const file of files) {
			for (const match of file.text.matchAll(pattern)) {
				found[`${file.name}#${match[1]}`] = Number(match[2])
			}
		}
		const recorded = Object.fromEntries(Object.entries(CONSTANTS).map(([k, v]) => [k, v.version]))
		const diff = differences(recorded, found)
		expect(diff, `A version constant changed.\n${diff.join('\n')}\n${RULE}`).toEqual([])
	})

	it('knows every record stamped through defineSchema', () => {
		const found: Record<string, number> = {}
		const pattern = /defineSchema\(\{\s*kind:\s*'([^']+)',\s*current:\s*(\d+)/g
		for (const file of files) {
			for (const match of file.text.matchAll(pattern)) found[match[1] as string] = Number(match[2])
		}
		const diff = differences(SCHEMAS, found)
		expect(diff, `A record schema version changed.\n${diff.join('\n')}\n${RULE}`).toEqual([])
	})

	it('knows every literal stamp it lists', () => {
		const diff: string[] = []
		for (const stamp of LITERAL_STAMPS) {
			const file = files.find((candidate) => candidate.name === stamp.file)
			const match = file ? stamp.pattern.exec(file.text) : null
			if (!match) diff.push(`not found: ${stamp.format} in ${stamp.file}`)
			else if (Number(match[1]) !== stamp.version) {
				diff.push(`changed: ${stamp.format} ${stamp.version} -> ${match[1]}`)
			}
		}
		expect(diff, `A literal stamp changed or moved.\n${diff.join('\n')}\n${RULE}`).toEqual([])
	})

	it('names no stamp twice', () => {
		const names = LITERAL_STAMPS.map((stamp) => stamp.format)
		expect(new Set(names).size).toBe(names.length)
	})
})
