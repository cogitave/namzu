import { describe, expect, it, vi } from 'vitest'

import {
	MAX_PERMISSION_REVIEW_BYTES,
	PERMISSION_REVIEW_PAGE_ROWS,
	buildPermissionReview,
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
