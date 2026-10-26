import { describe, expect, it } from 'vitest'

import { mergeGroupRows } from './group-rows.js'
import {
	EMPTY_GROUP,
	type FoldOp,
	type GroupState,
	HINT_INTERVAL_MS,
	HINT_MAX_CHARS,
	classifyCall,
	classifyShell,
	displayPath,
	foldOp,
	groupText,
	mergeGroups,
	visibleHint,
} from './read-search-group.js'
import type { TranscriptMessage } from './types.js'

const fold = (ops: readonly FoldOp[], now = 0): GroupState =>
	ops.reduce((state, op) => foldOp(state, op, now), EMPTY_GROUP)

describe('the counted line', () => {
	it('uses the progressive form with an ellipsis while open, and the past form once settled', () => {
		const state = fold([
			{ kind: 'search' },
			{ kind: 'search' },
			{ kind: 'read', key: 'a' },
			{ kind: 'read', key: 'b' },
			{ kind: 'read', key: 'c' },
		])
		expect(groupText(state, true)).toBe('Searching for 2 patterns, reading 3 files…')
		expect(groupText(state, false)).toBe('Searched for 2 patterns, read 3 files')
	})

	it('capitalises only the first clause and uses singular for one', () => {
		expect(groupText(fold([{ kind: 'list' }]), false)).toBe('Listed 1 directory')
		expect(
			groupText(fold([{ kind: 'read', key: 'a' }, { kind: 'list' }, { kind: 'list' }]), false),
		).toBe('Read 1 file, listed 2 directories')
		expect(groupText(fold([{ kind: 'search' }]), true)).toBe('Searching for 1 pattern…')
	})

	it('orders searches, reads, listings, then connectors, and never prints a zero', () => {
		const state = fold([
			{ kind: 'mcp', label: 'slack' },
			{ kind: 'list' },
			{ kind: 'read', key: 'a' },
			{ kind: 'search' },
		])
		expect(groupText(state, false)).toBe(
			'Searched for 1 pattern, read 1 file, listed 1 directory, called slack',
		)
	})

	it('names each connector once, in first-called order, and counts calls', () => {
		const state = fold([
			{ kind: 'mcp', label: 'slack' },
			{ kind: 'mcp', label: 'github' },
			{ kind: 'mcp', label: 'slack' },
			{ kind: 'mcp', label: 'github' },
		])
		expect(groupText(state, false)).toBe('Called slack, github 4 times')
		expect(groupText(fold([{ kind: 'mcp', label: 'slack' }]), true)).toBe('Calling slack…')
	})

	it('counts distinct files: the same one read twice is one file', () => {
		const state = fold([
			{ kind: 'read', key: 'a.ts' },
			{ kind: 'read', key: 'a.ts' },
			{ kind: 'read' },
		])
		expect(groupText(state, false)).toBe('Read 2 files')
	})

	it('never counts down', () => {
		let state = EMPTY_GROUP
		let previous = 0
		for (const op of [
			{ kind: 'read', key: 'a' },
			{ kind: 'search' },
			{ kind: 'read', key: 'a' },
			{ kind: 'list' },
		] as const) {
			state = foldOp(state, op, 0)
			const total =
				state.readKeys.length + state.anonymousReads + state.searches + state.lists + state.mcpCalls
			expect(total).toBeGreaterThanOrEqual(previous)
			previous = total
		}
	})

	it('merges neighbours without double counting a file', () => {
		const merged = mergeGroups(
			fold([{ kind: 'read', key: 'a' }, { kind: 'search' }]),
			fold([
				{ kind: 'read', key: 'a' },
				{ kind: 'read', key: 'b' },
				{ kind: 'mcp', label: 'x' },
			]),
		)
		expect(groupText(merged, false)).toBe('Searched for 1 pattern, read 2 files, called x')
	})
})

describe('the hint under a live line', () => {
	it('shows the first hint at once, holds a quicker one back, and shows it after the interval', () => {
		let state = foldOp(EMPTY_GROUP, { kind: 'read', key: 'a', hint: 'a.ts' }, 1000)
		expect(visibleHint(state, 1000)).toBe('a.ts')
		state = foldOp(state, { kind: 'read', key: 'b', hint: 'b.ts' }, 1100)
		expect(visibleHint(state, 1100)).toBe('a.ts')
		expect(visibleHint(state, 1000 + HINT_INTERVAL_MS - 1)).toBe('a.ts')
		expect(visibleHint(state, 1000 + HINT_INTERVAL_MS)).toBe('b.ts')
	})

	it('keeps the previous hint when a call brings none', () => {
		let state = foldOp(EMPTY_GROUP, { kind: 'read', key: 'a', hint: 'a.ts' }, 0)
		state = foldOp(state, { kind: 'mcp', label: 'x' }, 5000)
		expect(visibleHint(state, 5000)).toBe('a.ts')
	})

	it('cuts a long hint', () => {
		const state = foldOp(EMPTY_GROUP, { kind: 'search', hint: 'x'.repeat(1000) }, 0)
		const shown = visibleHint(state, 0) ?? ''
		expect(shown).toHaveLength(HINT_MAX_CHARS)
		expect(shown.endsWith('…')).toBe(true)
	})
})

describe('which shell commands only look', () => {
	it.each([
		['rg foo | head', 'search'],
		['cat a.ts && ls', 'list'],
		['ls -la src', 'list'],
		['cat a.ts | wc -l', 'read'],
		['grep -rn "a|b" src', 'search'],
		['find . -name "*.ts" | sort | uniq', 'search'],
		['echo start && cat a.ts', 'read'],
		['rg foo 2>&1 | head', 'search'],
		['find . -name x 2>/dev/null', 'search'],
		['grep -r foo . &>/dev/null', 'search'],
	])('%s is a %s', (command, kind) => {
		expect(classifyShell(command)).toBe(kind)
	})

	it.each([
		'git status',
		'echo hi',
		'npm test',
		'cat a.ts > out.txt',
		'cat a.ts >> out.txt',
		'cat a.ts 2>err.txt',
		'cat a.ts >/dev/nullx',
		'cat a.ts >&2 > out',
		'cat $(which node)',
		'cat `which node`',
		'ls & rm -rf x',
		'find . -delete',
		'find . -name x -exec rm {} ;',
		'sort -o out.txt in.txt',
		'awk \'{ print > "x" }\' a',
		'cat a.ts; rm a.ts',
		'cat <<EOF',
		'FOO=1 cat a',
		'(cat a)',
		'cat "unterminated',
	])('%s stays a row of its own', (command) => {
		expect(classifyShell(command)).toBeUndefined()
	})
})

describe('which calls fold', () => {
	const cwd = '/work'
	it('reads, searches and listings carry the target as the hint', () => {
		expect(classifyCall({ toolName: 'read', input: { path: 'src/a.ts' }, cwd })).toEqual({
			kind: 'read',
			key: 'src/a.ts',
			hint: 'src/a.ts',
		})
		expect(classifyCall({ toolName: 'read', input: { path: '/work/./src/a.ts' }, cwd })?.key).toBe(
			'src/a.ts',
		)
		expect(classifyCall({ toolName: 'grep', input: { pattern: 'useEffect' }, cwd })).toEqual({
			kind: 'search',
			hint: '"useEffect"',
		})
		expect(classifyCall({ toolName: 'glob', input: { pattern: '**/*.ts' }, cwd })?.kind).toBe(
			'search',
		)
		expect(classifyCall({ toolName: 'ls', input: { path: 'src' }, cwd })).toEqual({
			kind: 'list',
			hint: 'src',
		})
	})

	it('a read-like command folds with the command as its hint; others do not', () => {
		expect(classifyCall({ toolName: 'bash', input: { command: 'rg x\n\n  | head' } })).toEqual({
			kind: 'search',
			hint: '$ rg x\n| head',
		})
		expect(classifyCall({ toolName: 'bash', input: { command: 'npm test' } })).toBeUndefined()
		expect(
			classifyCall({ toolName: 'bash', input: { command: 'ls', run_in_background: true } }),
		).toBeUndefined()
	})

	it('every connector call folds under its server, with the query as the hint', () => {
		expect(classifyCall({ toolName: 'mcp__slack__post_message', input: { text: 'hi' } })).toEqual({
			kind: 'mcp',
			label: 'slack',
		})
		expect(classifyCall({ toolName: 'mcp__docs__search', input: { query: 'auth' } })).toEqual({
			kind: 'mcp',
			label: 'docs',
			hint: '"auth"',
		})
	})

	it('names a connector call with no known server MCP', () => {
		expect(groupText(foldOp(EMPTY_GROUP, { kind: 'mcp' }, 0), false)).toBe('Called MCP')
	})

	it('uses the server name as it is configured', () => {
		expect(classifyCall({ toolName: 'mcp__my server__go', input: {} })).toEqual({
			kind: 'mcp',
			label: 'my server',
		})
	})

	it('edits and writes do not fold', () => {
		expect(classifyCall({ toolName: 'edit', input: { path: 'a.ts' } })).toBeUndefined()
		expect(classifyCall({ toolName: 'write', input: { path: 'a.ts' } })).toBeUndefined()
	})

	it('shows paths from the working folder, else home, else whole', () => {
		expect(displayPath('/work/a/b.ts', '/work')).toBe('a/b.ts')
		expect(displayPath('/elsewhere/b.ts', '/work')).toBe('/elsewhere/b.ts')
	})
})

describe('resumed rows', () => {
	const row = (id: string, state: GroupState, detail: string[]): TranscriptMessage => ({
		id,
		role: 'tool',
		content: groupText(state, false),
		activity: 'exploration',
		group: state,
		detail,
	})
	it('neighbouring single-call rows become one line, with their bodies kept apart by a blank line', () => {
		const out = mergeGroupRows([
			{ id: 'u', role: 'user', content: 'go' },
			row('1', fold([{ kind: 'read', key: 'a' }]), ['Read a', 'text a']),
			row('2', fold([{ kind: 'search' }]), ['Searched', 'hit']),
			{ id: 't', role: 'assistant', content: 'done' },
			row('3', fold([{ kind: 'read', key: 'b' }]), ['Read b']),
		])
		expect(out.map((m) => m.content)).toEqual([
			'go',
			'Searched for 1 pattern, read 1 file',
			'done',
			'Read 1 file',
		])
		expect(out[1]?.detail).toEqual(['Read a', 'text a', '', 'Searched', 'hit'])
	})
})
