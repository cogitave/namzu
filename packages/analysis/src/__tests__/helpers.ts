import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { AnalysisPage, CodeAnalysisResult } from '@namzu/sdk'

import { type CodeAnalysisOptions, createCodeAnalysisProvider } from '../provider.js'

/** A scratch directory, canonical (macOS temp dirs are symlinks) and removed after. */
export class Tree {
	readonly root: string
	constructor(files: Record<string, string | Uint8Array> = {}) {
		this.root = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-analysis-')))
		for (const [rel, content] of Object.entries(files)) this.write(rel, content)
	}
	path(rel: string): string {
		return join(this.root, ...rel.split('/'))
	}
	write(rel: string, content: string | Uint8Array, mtimeSeconds?: number): void {
		mkdirSync(dirname(this.path(rel)), { recursive: true })
		writeFileSync(this.path(rel), content)
		// Pinned, so "unchanged" never depends on the clock's granularity.
		if (mtimeSeconds !== undefined) utimesSync(this.path(rel), mtimeSeconds, mtimeSeconds)
	}
	remove(rel: string): void {
		rmSync(this.path(rel), { recursive: true, force: true })
	}
	dispose(): void {
		rmSync(this.root, { recursive: true, force: true })
	}
}

export function provider(options: CodeAnalysisOptions = {}) {
	return createCodeAnalysisProvider(options)
}

/** Unwrap an `ok` result, failing the test with the reason otherwise. */
export function ok<T>(result: CodeAnalysisResult<T>): {
	value: T
	evidence: Extract<CodeAnalysisResult<T>, { kind: 'ok' }>['evidence']
} {
	if (result.kind !== 'ok') {
		throw new Error(
			`expected ok, got ${result.kind}: ${'error' in result ? result.error : result.reason}`,
		)
	}
	return { value: result.value, evidence: result.evidence }
}

export function failure<T>(result: CodeAnalysisResult<T>): string {
	if (result.kind === 'ok') throw new Error('expected a failure, got ok')
	return 'error' in result ? result.error : result.reason
}

/** Every item across every page of a paged call. */
export async function drain<T>(
	fetch: (cursor: string | undefined) => Promise<CodeAnalysisResult<AnalysisPage<T>>>,
): Promise<{ items: T[]; pages: number; total: number }> {
	const items: T[] = []
	let cursor: string | undefined
	let pages = 0
	let total = 0
	do {
		const page = ok(await fetch(cursor)).value
		items.push(...page.items)
		total = page.total
		cursor = page.nextCursor
		pages++
		if (pages > 1000) throw new Error('paging did not terminate')
	} while (cursor !== undefined)
	return { items, pages, total }
}

/** 1-based line and column of the n-th occurrence of `needle`, computed the dumb way. */
export function locate(
	text: string,
	needle: string,
	nth = 0,
): { offset: number; line: number; column: number } {
	let offset = -1
	for (let i = 0; i <= nth; i++) {
		offset = text.indexOf(needle, offset + 1)
		if (offset < 0) throw new Error(`${needle} occurrence ${nth} not found`)
	}
	const before = text.slice(0, offset)
	const line = before.split('\n').length
	const column = offset - (before.lastIndexOf('\n') + 1) + 1
	return { offset, line, column }
}
