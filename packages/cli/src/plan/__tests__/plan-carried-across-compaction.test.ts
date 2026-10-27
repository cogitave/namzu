import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { MAX_CARRIED_PLAN_CHARS, planCarriedAcrossCompaction } from '../plan-file.js'

let dir: string
let plan: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-plan-carried-'))
	mkdirSync(join(dir, 'plans'))
	plan = join(dir, 'plans', 'plan.md')
})

afterEach(() => removeTempDir(dir))

describe('the plan a compaction carries', () => {
	it('names the file and quotes the plan as it reads now', async () => {
		writeFileSync(plan, '# Plan\n\n1. Add the thing\n2. Test it\n')

		const note = (await planCarriedAcrossCompaction(plan)) ?? ''

		expect(note).toContain(plan)
		expect(note).toContain('1. Add the thing')
		expect(note).toContain('keep following it')
	})

	it('carries nothing when no plan was written, or it is blank', async () => {
		expect(await planCarriedAcrossCompaction(plan)).toBeUndefined()
		writeFileSync(plan, '  \n')
		expect(await planCarriedAcrossCompaction(plan)).toBeUndefined()
	})

	it('cuts a very long plan and points at the file for the rest', async () => {
		writeFileSync(plan, `${'step\n'.repeat(MAX_CARRIED_PLAN_CHARS)}`)

		const note = (await planCarriedAcrossCompaction(plan)) ?? ''

		expect(note.length).toBeLessThan(MAX_CARRIED_PLAN_CHARS + 600)
		expect(note).toContain('the rest of the plan is in the file')
	})
})
