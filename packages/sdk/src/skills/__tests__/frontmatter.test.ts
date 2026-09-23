import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'

import { parseFrontmatter } from '../../utils/frontmatter.js'
import { SKILL_FRONTMATTER_KEYS, loadSkill } from '../loader.js'

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
	removeTempDir(dir)
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
				'compatibility: [node, bun]',
				'---',
			].join('\n'),
		)
		await expect(loadSkill(path, 'full')).rejects.toThrow(/flow sequence/)
	})

	it('reads a flow sequence for allowed-tools, which the format writes as a list', async () => {
		// The one key a list is accepted for: the Agent Skills format writes
		// `allowed-tools` space-separated, comma-separated or as a list, and
		// the joined value means what the list did.
		const path = skill(
			[
				'---',
				'name: a-skill',
				'description: Does a thing',
				'allowed-tools: [Read, Grep]',
				'---',
			].join('\n'),
		)
		const loaded = await loadSkill(path, 'full')
		expect(loaded.skill.metadata.allowedTools).toBe('Read, Grep')
	})

	it('names the file and the field it refused', async () => {
		const path = skill(['---', 'name: a-skill', 'description: |', '  text', '---'].join('\n'))
		await expect(loadSkill(path, 'full')).rejects.toThrow(/description/)
	})
})

describe('a SKILL.md authored on Windows', () => {
	/**
	 * The unit tests for the shared reader cover CRLF directly. This one
	 * drives `loadSkill`, because a reader that handles CRLF proves nothing
	 * about the caller if the caller re-splits the file itself — and the
	 * defect this came from was exactly that, one layer up in the CLI.
	 */
	it('loads with its frontmatter intact rather than falling back to the directory name', async () => {
		const path = skill(
			['---', 'name: a-skill', 'description: Does a useful thing', '---', '', 'Body text.'].join(
				'\r\n',
			),
		)

		const loaded = await loadSkill(path, 'full')
		expect(loaded.skill.metadata.name).toBe('a-skill')
		expect(loaded.skill.metadata.description).toBe('Does a useful thing')
		expect(loaded.skill.metadata.description).not.toMatch(/\r/)
		expect(loaded.skill.body).toBe('Body text.')
	})

	it('carries a CRLF metadata block through to the skill', async () => {
		const path = skill(
			[
				'---',
				'name: a-skill',
				'description: Does a useful thing',
				'metadata:',
				'  author: someone',
				'---',
				'',
				'Body text.',
			].join('\r\n'),
		)

		const loaded = await loadSkill(path, 'full')
		expect(loaded.skill.metadata.metadata).toEqual({ author: 'someone' })
		expect(loaded.skill.metadata.metadata?.author).not.toMatch(/\r/)
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

describe('keys the skill loader does not read', () => {
	// A skill written for another agent carries fields this kernel ignores,
	// and some of them are lists. Refusing the whole file over syntax in a
	// field nothing reads made such a skill unusable for no gain.
	it('are skipped whole, whatever YAML they use', async () => {
		const path = skill(
			[
				'---',
				'name: a-skill',
				'description: reviews a pull request',
				'argument-hint: [pr-number]',
				'user-invocable: false',
				'hooks:',
				'  PreToolUse:',
				'    - matcher: Bash',
				'notes: >-',
				'  folded text',
				'tags: {a: b}',
				'---',
				'',
				'Body.',
			].join('\n'),
		)

		const loaded = await loadSkill(path, 'full')
		expect(loaded.skill.metadata).toEqual({
			name: 'a-skill',
			description: 'reviews a pull request',
		})
		expect(loaded.skill.body).toBe('Body.')
	})

	it('do not relax a key the loader reads', async () => {
		// A list in a key the loader reads and does not take as a list is still
		// refused: a value read wrongly is the failure the refusal exists for.
		// (`allowed-tools` is read as a list on purpose.)
		const path = skill(['---', 'name: a-skill', 'description: [d, e]', '---', 'b'].join('\n'))
		await expect(loadSkill(path, 'full')).rejects.toThrow(/flow sequence/)
	})

	it('names the vocabulary in one exported list', () => {
		expect(SKILL_FRONTMATTER_KEYS).toContain('allowed-tools')
		expect(SKILL_FRONTMATTER_KEYS).toContain('disable-model-invocation')
		expect(SKILL_FRONTMATTER_KEYS).not.toContain('argument-hint')
	})
})

describe('parseFrontmatter without readsKey', () => {
	it('still refuses unsupported YAML in any key', () => {
		expect(() => parseFrontmatter('---\nfoo: [a]\n---\n', 'x')).toThrow(/flow sequence/)
		expect(() =>
			parseFrontmatter('---\nfoo: [a]\n---\n', 'x', { readsKey: (key) => key !== 'foo' }),
		).not.toThrow()
	})
})
