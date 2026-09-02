/**
 * What an agent file must say, and what happens to one that says it wrong.
 *
 * Refusal is the property under test as much as loading: a file with a
 * broken `tools:` line that loaded anyway would run with the parent's whole
 * set, which is the opposite of what the line was for. So every refusal
 * names the file and the reason, and the rest of the roster survives it.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import {
	MAX_AGENT_FILE_CHARS,
	discoverAgentDefinitions,
	parseAgentMarkdown,
	projectAgentsDir,
	userAgentsDir,
} from '../definitions.js'

const GOOD = [
	'---',
	'name: reviewer',
	'description: Reviews a diff for correctness.',
	'tools: read, grep, glob',
	'model: some-model',
	'readOnly: true',
	'---',
	'You review changes. Cite file:line.',
].join('\n')

describe('parseAgentMarkdown', () => {
	it('reads every field, and the body as the prompt', () => {
		const parsed = parseAgentMarkdown(GOOD, '/p/reviewer.md', 'project')
		expect(parsed).toEqual({
			name: 'reviewer',
			description: 'Reviews a diff for correctness.',
			prompt: 'You review changes. Cite file:line.',
			tools: ['read', 'grep', 'glob'],
			model: 'some-model',
			readOnly: true,
			path: '/p/reviewer.md',
			source: 'project',
		})
	})

	it.each([
		['no frontmatter', 'Just a body.', 'no frontmatter'],
		['no name', '---\ndescription: x\n---\nbody', 'no `name:`'],
		['a bad name', '---\nname: My Agent\ndescription: x\n---\nbody', 'not a lower-case identifier'],
		['a built-in name', '---\nname: explore\ndescription: x\n---\nbody', 'built-in type'],
		['no description', '---\nname: a\n---\nbody', 'no `description:`'],
		[
			'an empty tools list',
			'---\nname: a\ndescription: x\ntools: ,\n---\nbody',
			'`tools:` must be',
		],
		[
			'a bad readOnly',
			'---\nname: a\ndescription: x\nreadOnly: yes\n---\nbody',
			'`readOnly:` must be',
		],
		['an empty body', '---\nname: a\ndescription: x\n---\n', 'empty body'],
	])('refuses a file with %s and says why', (_label, raw, reason) => {
		const parsed = parseAgentMarkdown(raw, '/p/a.md', 'project')
		expect('reason' in parsed).toBe(true)
		if ('reason' in parsed) expect(parsed.reason).toContain(reason)
	})

	it('cuts an oversized body at the budget and says so in the prompt', () => {
		const body = 'x'.repeat(MAX_AGENT_FILE_CHARS + 10)
		const parsed = parseAgentMarkdown(
			`---\nname: a\ndescription: x\n---\n${body}`,
			'/p/a.md',
			'user',
		)
		if ('reason' in parsed) throw new Error(parsed.reason)
		expect(parsed.prompt.length).toBeGreaterThan(MAX_AGENT_FILE_CHARS)
		expect(parsed.prompt).toContain('10 were omitted')
	})
})

let root: string
let home: string
let cwd: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-agents-'))
	home = join(root, 'home')
	cwd = join(root, 'project')
	mkdirSync(userAgentsDir(home), { recursive: true })
	mkdirSync(projectAgentsDir(cwd), { recursive: true })
})

afterEach(() => {
	removeTempDir(root)
})

describe('discoverAgentDefinitions', () => {
	it('loads both directories, project shadowing user, and reports what it refused', () => {
		writeFileSync(join(userAgentsDir(home), 'reviewer.md'), GOOD)
		writeFileSync(
			join(userAgentsDir(home), 'scribe.md'),
			'---\nname: scribe\ndescription: Writes docs.\n---\nWrite docs.',
		)
		writeFileSync(
			join(projectAgentsDir(cwd), 'reviewer.md'),
			'---\nname: reviewer\ndescription: The project reviewer.\n---\nProject rules.',
		)
		writeFileSync(join(projectAgentsDir(cwd), 'broken.md'), 'no frontmatter here')

		const { definitions, skipped } = discoverAgentDefinitions({ cwd, home })

		expect(definitions.map((d) => [d.name, d.source, d.description])).toEqual([
			['reviewer', 'project', 'The project reviewer.'],
			['scribe', 'user', 'Writes docs.'],
		])
		expect(skipped).toHaveLength(1)
		expect(skipped[0]?.path).toBe(join(projectAgentsDir(cwd), 'broken.md'))
		expect(skipped[0]?.reason).toContain('no frontmatter')
	})

	it('contributes nothing when neither directory exists', () => {
		const empty = mkdtempSync(join(tmpdir(), 'namzu-agents-none-'))
		try {
			expect(discoverAgentDefinitions({ cwd: empty, home: empty })).toEqual({
				definitions: [],
				skipped: [],
			})
		} finally {
			removeTempDir(empty)
		}
	})
})
