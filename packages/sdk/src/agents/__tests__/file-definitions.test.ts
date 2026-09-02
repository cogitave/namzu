/**
 * What an agent file must say, and what happens to one that says it wrong.
 *
 * Refusal is the property under test as much as loading: a file with a
 * broken `tools:` line that loaded anyway would run with the parent's whole
 * set, which is the opposite of what the line was for. So every refusal
 * names the file and the reason, and the rest of the roster survives it.
 * Root order is the host's: a later root shadows an earlier one by name.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	MAX_AGENT_FILE_CHARS,
	discoverAgentDefinitions,
	parseAgentMarkdown,
} from '../file-definitions.js'

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
		expect(parseAgentMarkdown(GOOD, '/p/reviewer.md', 'project')).toEqual({
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

	it('lets a host reserve its own names', () => {
		const parsed = parseAgentMarkdown(
			'---\nname: reviewer\ndescription: x\n---\nbody',
			'/p/a.md',
			'project',
			new Set(['reviewer']),
		)
		expect('reason' in parsed && parsed.reason).toContain('built-in type')
	})

	it('cuts an oversized body at the budget and says so in the prompt', () => {
		const body = 'x'.repeat(MAX_AGENT_FILE_CHARS + 10)
		const parsed = parseAgentMarkdown(`---\nname: a\ndescription: x\n---\n${body}`, '/p/a.md', 'u')
		if ('reason' in parsed) throw new Error(parsed.reason)
		expect(parsed.prompt.length).toBeGreaterThan(MAX_AGENT_FILE_CHARS)
		expect(parsed.prompt).toContain('10 were omitted')
	})
})

let root: string
let userDir: string
let projectDir: string

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'namzu-agent-files-'))
	userDir = join(root, 'user')
	projectDir = join(root, 'project')
	await mkdir(userDir, { recursive: true })
	await mkdir(projectDir, { recursive: true })
})

afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})

describe('discoverAgentDefinitions', () => {
	it('loads every root, later roots shadowing earlier ones, and reports what it refused', async () => {
		await writeFile(join(userDir, 'reviewer.md'), GOOD)
		await writeFile(
			join(userDir, 'scribe.md'),
			'---\nname: scribe\ndescription: Writes docs.\n---\nWrite docs.',
		)
		await writeFile(
			join(projectDir, 'reviewer.md'),
			'---\nname: reviewer\ndescription: The project reviewer.\n---\nProject rules.',
		)
		await writeFile(join(projectDir, 'broken.md'), 'no frontmatter here')

		const { definitions, skipped } = await discoverAgentDefinitions([
			{ dir: userDir, source: 'user' },
			{ dir: projectDir, source: 'project' },
		])

		expect(definitions.map((d) => [d.name, d.source, d.description])).toEqual([
			['reviewer', 'project', 'The project reviewer.'],
			['scribe', 'user', 'Writes docs.'],
		])
		expect(skipped).toEqual([
			{ path: join(projectDir, 'broken.md'), reason: expect.stringContaining('no frontmatter') },
		])
	})

	it('contributes nothing for a root that does not exist', async () => {
		expect(await discoverAgentDefinitions([{ dir: join(root, 'nope'), source: 'x' }])).toEqual({
			definitions: [],
			skipped: [],
		})
	})
})
