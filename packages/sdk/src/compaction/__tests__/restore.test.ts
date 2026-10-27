import { describe, expect, it } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import { WorkingStateManager } from '../manager.js'
import {
	RESTORE_FILE_TOKENS,
	RESTORE_MAX_FILES,
	recordRestorable,
	renderRestoredContext,
} from '../restore.js'
import { restoreWorkingState, snapshotWorkingState } from '../wire.js'

const config = CompactionConfigSchema.parse({})

function manager(): WorkingStateManager {
	return new WorkingStateManager(config)
}

const read = (m: WorkingStateManager, path: string, output = `body of ${path}`) =>
	recordRestorable(m, { toolName: 'read', input: { path }, output, success: true })

describe('which bodies come back', () => {
	it('brings back the most recent reads, five at most, newest first', () => {
		const m = manager()
		for (let i = 1; i <= 7; i += 1) read(m, `f${i}.ts`)

		const text = renderRestoredContext(m.getState()) ?? ''
		const shown = [...text.matchAll(/### File: (\S+)/g)].map((found) => found[1])

		expect(shown).toEqual(['f7.ts', 'f6.ts', 'f5.ts', 'f4.ts', 'f3.ts'])
		expect(shown).toHaveLength(RESTORE_MAX_FILES)
	})

	it('moves a file read again to the front instead of listing it twice', () => {
		const m = manager()
		read(m, 'a.ts')
		read(m, 'b.ts')
		read(m, 'a.ts', 'newer body of a')

		const text = renderRestoredContext(m.getState()) ?? ''

		expect(text.indexOf('### File: a.ts')).toBeLessThan(text.indexOf('### File: b.ts'))
		expect(text).toContain('newer body of a')
		expect(text.match(/### File: a\.ts/g)).toHaveLength(1)
	})

	it('leaves out instruction files, the plan file and failed reads', () => {
		const m = manager()
		read(m, 'AGENTS.md')
		read(m, 'pkg/AGENTS.local.md')
		read(m, 'repo/.namzu/rules/style.md')
		read(m, '/home/me/.namzu/projects/x/s/plans/plan.md')
		recordRestorable(m, {
			toolName: 'read',
			input: { path: 'gone.ts' },
			output: 'no such file',
			success: false,
		})
		read(m, 'kept.ts')

		const text = renderRestoredContext(m.getState()) ?? ''

		expect(text).toContain('### File: kept.ts')
		expect(text).not.toContain('AGENTS')
		expect(text).not.toContain('rules/style.md')
		expect(text).not.toContain('plan.md')
		expect(text).not.toContain('gone.ts')
	})

	it('forgets a file once it has been changed, since the body is behind the disk', () => {
		const m = manager()
		read(m, 'a.ts')
		recordRestorable(m, {
			toolName: 'edit',
			input: { path: './a.ts' },
			output: 'ok',
			success: true,
		})

		expect(renderRestoredContext(m.getState())).toBeUndefined()
	})

	it('cuts one file to its cap and says so', () => {
		const m = manager()
		read(m, 'big.ts', 'x'.repeat(23_000))

		const text = renderRestoredContext(m.getState()) ?? ''

		expect(text).toContain('cut to fit the restore budget')
		expect(text.length).toBeLessThan((RESTORE_FILE_TOKENS + 200) * 4 + 500)
	})

	it('scales down to a share of a small window', () => {
		const m = manager()
		for (let i = 0; i < 5; i += 1) read(m, `f${i}.ts`, 'y'.repeat(15_000))

		const full = renderRestoredContext(m.getState()) ?? ''
		const small = renderRestoredContext(m.getState(), { contextWindowTokens: 10_000 }) ?? ''

		expect(small.length).toBeLessThan(full.length / 3)
		// 10% of a 10,000-token window is 1,000 tokens, about 4,000 characters.
		expect(small.length).toBeLessThan(5_500)
	})

	it('brings back a skill that arrived in pages as one body', () => {
		const m = manager()
		recordRestorable(m, {
			toolName: 'skill',
			input: { name: 'deploy' },
			output:
				'First page.\n\n[More skill instructions remain. Call skill again with name "deploy" and cursor "v1.x" before acting.]',
			success: true,
		})
		recordRestorable(m, {
			toolName: 'skill',
			input: { name: 'deploy', cursor: 'v1.x' },
			output: ' Second page.',
			success: true,
		})

		const text = renderRestoredContext(m.getState()) ?? ''

		expect(text).toContain('First page. Second page.')
		expect(text).not.toContain('More skill instructions remain')
	})

	it('survives a snapshot, so a resumed session restores the same bodies', () => {
		const m = manager()
		read(m, 'a.ts')
		recordRestorable(m, { toolName: 'skill', input: { name: 's' }, output: 'steps', success: true })

		const revived = restoreWorkingState(JSON.parse(JSON.stringify(snapshotWorkingState(m))), config)

		expect(renderRestoredContext(revived.getState())).toBe(renderRestoredContext(m.getState()))
	})

	it('says nothing without bodies or a note, and carries a host note alone', () => {
		const m = manager()
		expect(renderRestoredContext(m.getState())).toBeUndefined()
		expect(renderRestoredContext(m.getState(), { hostNote: 'Plan at p.md' })).toContain(
			'Plan at p.md',
		)
	})
})
