import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadSkill } from '../loader.js'

/**
 * The frontmatter reader is a flat key/value splitter, and the documented
 * contract says "YAML frontmatter" with no restriction — so an author has
 * every reason to write a block scalar or a flow sequence, and no reason to
 * expect what happened next.
 *
 * All three failures were silent. `description: >-` with an indented
 * paragraph produced the literal `">-"`, which passed validation and
 * registered with no warning: the skill existed and was never selected,
 * because its description said nothing. `[Read, Grep]` became that literal
 * text and was interpolated into the prompt. And a `---` inside a quoted
 * value cut the frontmatter there, truncating the metadata AND spilling the
 * remainder into the body, which reaches the system prompt verbatim.
 */

let dir: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-skill-'))
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

function skill(content: string): string {
	const skillDir = join(dir, 'a-skill')
	mkdirSync(skillDir, { recursive: true })
	writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8')
	return skillDir
}

describe('the closing fence', () => {
	it('is a line of its own, not `---` wherever it appears', async () => {
		const path = skill(
			[
				'---',
				'name: a-skill',
				'description: "Handles the --- separator in CSV files"',
				'---',
				'',
				'Body text.',
			].join('\n'),
		)

		const loaded = await loadSkill(path, 'full')
		// The unanchored search cut here, losing the rest of the metadata.
		expect(loaded.skill.metadata.description).toContain('CSV')
		expect(loaded.skill.body).toBe('Body text.')
	})

	it('does not spill frontmatter into the body', async () => {
		const path = skill(
			['---', 'name: a-skill', 'description: "uses --- a lot"', '---', '', 'Real body.'].join('\n'),
		)

		const loaded = await loadSkill(path, 'full')
		// The body reaches the system prompt verbatim, so a leak here is a
		// leak into the prompt.
		expect(loaded.skill.body).not.toContain('description:')
		expect(loaded.skill.body).toBe('Real body.')
	})

	it('still rejects genuinely unclosed frontmatter', async () => {
		const path = skill(['---', 'name: a-skill', 'description: no closing fence'].join('\n'))
		await expect(loadSkill(path, 'full')).rejects.toThrow(/unclosed/)
	})
})

describe('YAML this reader does not implement', () => {
	it('refuses a block scalar instead of reading it as ">-"', async () => {
		const path = skill(
			[
				'---',
				'name: a-skill',
				'description: >-',
				'  A long description that wraps',
				'  across two lines.',
				'---',
				'',
				'Body.',
			].join('\n'),
		)

		// Registering this produced a skill whose description was ">-" —
		// present, valid, and never selected by the model.
		await expect(loadSkill(path, 'full')).rejects.toThrow(/block scalar/)
	})

	it('refuses a flow sequence instead of interpolating its text', async () => {
		const path = skill(
			[
				'---',
				'name: a-skill',
				'description: Does a thing',
				'allowed-tools: [Read, Grep]',
				'---',
			].join('\n'),
		)
		await expect(loadSkill(path, 'full')).rejects.toThrow(/flow sequence/)
	})

	it('names the file and the field it refused', async () => {
		const path = skill(['---', 'name: a-skill', 'description: |', '  text', '---'].join('\n'))
		await expect(loadSkill(path, 'full')).rejects.toThrow(/description/)
	})
})

describe('ordinary frontmatter', () => {
	it('still loads', async () => {
		const path = skill(
			['---', 'name: a-skill', 'description: Does a useful thing', '---', '', 'Body.'].join('\n'),
		)

		const loaded = await loadSkill(path, 'full')
		expect(loaded.skill.metadata.name).toBe('a-skill')
		expect(loaded.skill.metadata.description).toBe('Does a useful thing')
		expect(loaded.skill.body).toBe('Body.')
	})

	it('accepts a quoted value with a colon in it', async () => {
		const path = skill(
			['---', 'name: a-skill', 'description: "Reads a URL: http://example.com"', '---'].join('\n'),
		)
		const loaded = await loadSkill(path, 'full')
		expect(loaded.skill.metadata.description).toContain('http://example.com')
	})
})
