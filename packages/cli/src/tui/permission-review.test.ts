import { describe, expect, it, vi } from 'vitest'

import {
	MAX_PERMISSION_REVIEW_BYTES,
	PERMISSION_REVIEW_PAGE_ROWS,
	buildPermissionReview,
	buildPermissionSummary,
	permissionReviewRows,
} from './permission-review.js'

describe('buildPermissionReview', () => {
	it('round-trips the complete batch and accounts for its exact UTF-8 size', () => {
		const input = {
			command: `echo ${'safe '.repeat(80)}&& git push origin main`,
			args: ['a', 'ışık', true, null],
		}
		const result = buildPermissionReview([
			{ id: 'call_1', name: 'bash', input, isDestructive: true },
			{
				id: 'call_2',
				name: 'write',
				input: { path: '/tmp/x', content: 'done' },
				isDestructive: false,
			},
		])

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(JSON.parse(result.text)).toEqual({
			calls: [
				{ id: 'call_1', name: 'bash', input, isDestructive: true },
				{
					id: 'call_2',
					name: 'write',
					input: { path: '/tmp/x', content: 'done' },
					isDestructive: false,
				},
			],
		})
		expect(result.text).toContain('git push origin main')
		expect(result.bytes).toBe(Buffer.byteLength(result.text, 'utf8'))
		expect(result.bytes).toBeLessThanOrEqual(MAX_PERMISSION_REVIEW_BYTES)
	})

	it('refuses the whole batch instead of cutting an oversized value', () => {
		expect(
			buildPermissionReview([
				{
					id: 'call_1',
					name: 'bash',
					input: { command: 'x'.repeat(MAX_PERMISSION_REVIEW_BYTES) },
					isDestructive: true,
				},
			]),
		).toEqual({ ok: false, reason: 'too_large' })
	})

	it('refuses accessors and custom objects without invoking user code', () => {
		const readInput = vi.fn(() => ({ command: 'git push origin main' }))
		const call = Object.defineProperty(
			{ id: 'call_1', name: 'bash', isDestructive: true },
			'input',
			{ enumerable: true, get: readInput },
		)

		expect(buildPermissionReview([call as never])).toEqual({
			ok: false,
			reason: 'unrepresentable',
		})
		expect(readInput).not.toHaveBeenCalled()
		expect(
			buildPermissionReview([
				{ id: 'call_1', name: 'write', input: new Date(0), isDestructive: false },
			]),
		).toEqual({ ok: false, reason: 'unrepresentable' })
	})
})

describe('buildPermissionSummary', () => {
	it('shows every executable bash field without the outer JSON envelope', () => {
		const review = buildPermissionReview([
			{
				id: 'call_1',
				name: 'bash',
				input: {
					command: 'printf "safe" && git push origin main',
					timeout: 12_000,
					run_in_background: false,
				},
				isDestructive: true,
			},
		])
		expect(review.ok).toBe(true)
		if (!review.ok) return

		const summary = buildPermissionSummary(review.text)
		expect(summary.complete).toBe(true)
		expect(summary.text).toContain('$ printf \\"safe\\" && git push origin main')
		expect(summary.text).toContain('timeout: 12000 ms')
		expect(summary.text).toContain('background: no')
		expect(summary.text).not.toContain('"calls"')
	})

	it('keeps a phased parallel Agent batch readable instead of opening its wire envelope', () => {
		const review = buildPermissionReview(
			['API research', 'Security review', 'UX critique', 'Delivery plan'].map(
				(description, index) => ({
					id: `call_${index}`,
					name: 'Agent',
					input: {
						description,
						prompt: `Complete ${description.toLowerCase()} and report evidence.`,
						role: 'Focused reviewer',
						workflow: 'Product review',
						phase: 'Research',
						phase_order: 0,
					},
					isDestructive: false,
				}),
			),
		)
		expect(review.ok).toBe(true)
		if (!review.ok) return

		const summary = buildPermissionSummary(review.text)
		expect(summary.complete).toBe(true)
		expect(summary.text.split('\n').slice(0, 4)).toEqual([
			'1. API research',
			'2. Security review',
			'3. UX critique',
			'4. Delivery plan',
		])
		expect(summary.text).toContain('Task: API research')
		expect(summary.text).toContain('Instructions: Complete api research and report evidence.')
		expect(summary.text).toContain('Workflow: Product review')
		expect(summary.text).toContain('Phase order: 1')
		expect(summary.text).toContain('Task: Delivery plan')
		expect(summary.text).not.toContain('call_0')
		expect(summary.text).not.toContain('"calls"')
	})

	it('shows a tool no formatter knows key by key, complete, with nothing hidden', () => {
		const unknown = buildPermissionReview([
			{
				id: 'call_1',
				name: 'plugin_deploy',
				input: { target: 'prod', suffix: 'do-not-hide', nested: { flag: true }, note: 'a\nb' },
				isDestructive: true,
			},
		])
		expect(unknown.ok).toBe(true)
		if (!unknown.ok) return
		const unknownSummary = buildPermissionSummary(unknown.text)
		expect(unknownSummary.complete).toBe(true)
		expect(unknownSummary.text).toContain('1. plugin_deploy · destructive')
		expect(unknownSummary.text).toContain('   target: "prod"')
		expect(unknownSummary.text).toContain('   suffix: "do-not-hide"')
		expect(unknownSummary.text).toContain('   nested: {"flag":true}')
		// A newline inside a value stays escaped, so it cannot pose as a key.
		expect(unknownSummary.text).toContain('   note: "a\\nb"')
	})

	it('keeps a batch readable when a read rides along with a shell call', () => {
		const batch = buildPermissionReview([
			{ id: 'call_1', name: 'read', input: { path: 'src/slug.mjs' }, isDestructive: false },
			{ id: 'call_2', name: 'bash', input: { command: 'npm test' }, isDestructive: false },
		])
		expect(batch.ok).toBe(true)
		if (!batch.ok) return
		const summary = buildPermissionSummary(batch.text)
		expect(summary.complete).toBe(true)
		expect(summary.text).toContain('1. read\n   path: "src/slug.mjs"')
		expect(summary.text).toContain('2. bash\n   $ npm test')
	})

	it('opens exact-first for a tool whose name is not a plain token', () => {
		const odd = buildPermissionReview([
			{ id: 'call_1', name: 'bash\u0007', input: { command: 'echo' }, isDestructive: true },
		])
		expect(odd.ok).toBe(true)
		if (!odd.ok) return
		expect(buildPermissionSummary(odd.text).complete).toBe(false)
	})

	it('requires exact-input-first review for an evolved shape of a tool it formats', () => {
		const evolvedBash = buildPermissionReview([
			{
				id: 'call_2',
				name: 'bash',
				input: { command: 'echo ok', new_authority: 'hidden-if-formatter-is-stale' },
				isDestructive: false,
			},
		])
		expect(evolvedBash.ok).toBe(true)
		if (!evolvedBash.ok) return
		expect(buildPermissionSummary(evolvedBash.text).complete).toBe(false)
	})
})

describe('permissionReviewRows', () => {
	it('pages one long JSON string by physical terminal rows so its suffix stays reachable', () => {
		const suffix = 'UNIQUE_DESTRUCTIVE_SUFFIX'
		const result = buildPermissionReview([
			{
				id: 'call_1',
				name: 'bash',
				input: { command: `${'x'.repeat(480)}${suffix}` },
				isDestructive: true,
			},
		])
		expect(result.ok).toBe(true)
		if (!result.ok) return

		const rows = permissionReviewRows(result.text, 40)
		expect(rows.length).toBeGreaterThan(PERMISSION_REVIEW_PAGE_ROWS)
		expect(
			rows
				.slice(0, PERMISSION_REVIEW_PAGE_ROWS)
				.map((row) => row.text)
				.join(''),
		).not.toContain(suffix)
		expect(
			rows
				.slice(PERMISSION_REVIEW_PAGE_ROWS)
				.map((row) => row.text)
				.join(''),
		).toContain(suffix)
		for (const row of rows) {
			const conservativeCells = [...row.text].reduce((sum, point) => {
				const codePoint = point.codePointAt(0)
				return sum + (codePoint !== undefined && codePoint <= 0x7e ? 1 : 2)
			}, 0)
			expect(conservativeCells).toBeLessThanOrEqual(30)
		}
	})
})

describe('buildPermissionSummary — a file change reads as a change', () => {
	const review = (name: string, input: unknown) => {
		const built = buildPermissionReview([{ id: 'c1', name, input, isDestructive: false }])
		if (!built.ok) throw new Error('review must be representable')
		return buildPermissionSummary(built.text)
	}

	it('shows one replacement as - and + lines under the path', () => {
		const summary = review('edit', {
			path: 'src/a.ts',
			old_string: 'const a = 1\nconst b = 2',
			new_string: 'const a = 10',
		})
		expect(summary.complete).toBe(true)
		expect(summary.text).toContain('src/a.ts')
		expect(summary.text).toContain('   - const a = 1')
		expect(summary.text).toContain('   - const b = 2')
		expect(summary.text).toContain('   + const a = 10')
		expect(summary.text, 'the JSON envelope stays behind `d`').not.toContain('old_string')
	})

	it('shows an insertion as + lines at its line, and a list of edits one after another', () => {
		const insert = review('edit', { path: 'x.md', insertLine: 'end', newStr: 'tail' })
		expect(insert.complete).toBe(true)
		expect(insert.text).toContain('x.md · insert at end')
		expect(insert.text).toContain('   + tail')

		const many = review('edit', {
			path: 'y.ts',
			edits: [
				{ old_string: 'one', new_string: 'uno' },
				{ old_string: 'two', new_string: 'dos', replace_all: true },
			],
		})
		expect(many.complete).toBe(true)
		expect(many.text).toContain('y.ts · 2 replacements')
		expect(many.text).toContain('@ 2 · every occurrence')
		expect(many.text.indexOf('- one')).toBeLessThan(many.text.indexOf('- two'))
	})

	it('counts the lines a long side does not show, and never drops the exact view', () => {
		const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
		const summary = review('edit', { path: 'z.ts', old_string: 'x', new_string: long })
		expect(summary.complete).toBe(true)
		expect(summary.text).toContain('+ line 39')
		expect(summary.text).not.toContain('+ line 40')
		expect(summary.text).toContain('+ … 10 more lines')
	})

	it('shows a write as the file it creates', () => {
		const summary = review('write', { path: 'new.txt', content: 'a\nb\nc' })
		expect(summary.complete).toBe(true)
		expect(summary.text).toContain('new.txt · write 3 lines')
		expect(summary.text).toContain('   + a')
		expect(summary.text).toContain('   + c')
	})

	it('falls back to exact-input-first for an edit shape it does not know', () => {
		// Both spellings of the same field is an evolved shape; picking one
		// half would show a change the tool does not make.
		const summary = review('edit', {
			path: 'a.ts',
			old_string: 'x',
			oldStr: 'y',
			new_string: 'z',
		})
		expect(summary.complete).toBe(false)
		expect(summary.text).toContain('input:')
	})
})
