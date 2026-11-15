import type { BrowserPageInfo, BrowserResult } from '../../types/browser/index.js'
import type { ToolResult } from '../../types/tool/index.js'

/**
 * A repeated browser call that changes nothing is the commonest way a small
 * model burns a turn: the same click on the same element, again and again,
 * while the page stays as it was. The guard watches what the host returned
 * for each call and speaks up in three steps:
 *
 * - the third identical call in a row with the page unchanged gets a note;
 * - the fifth is refused, naming the last thing the page showed;
 * - twelve page-changing calls with no new address, tree or tab get a note
 *   asking the model to say what blocks it.
 *
 * "Identical" is the tool, the action and every argument. "Unchanged" is the
 * address, the tab set and the last whole-page snapshot, as the host reported
 * them. Nothing here reads a clock, so nothing here depends on how fast the
 * machine is.
 */

/** The call number that earns a note. */
export const STALL_NOTE_AT = 3
/** The call number that is refused. */
export const STALL_REFUSE_AT = 5
/** Page-changing calls without any sign of progress before the second note. */
export const NO_PROGRESS_NOTE_AFTER = 12

/** What a tool call looked like, for the guard. */
export interface StalledCall {
	readonly tool: string
	readonly input: unknown
	/** Only an action that can change what the page shows takes part. */
	readonly counts: boolean
	/** The call returned the whole page (no region, no cursor). */
	readonly wholePage: boolean
}

interface Repeat {
	count: number
	/** The page signature after the call; compared with the one the next call starts from. */
	after: string
	/** The call itself left the signature as it found it. */
	unchanged: boolean
	last: string
}

function fnv1a(text: string): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(16)
}

/** Stable text for an input: keys sorted, so `{a,b}` and `{b,a}` are the same call. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
	if (typeof value === 'object' && value !== null) {
		const record = value as Record<string, unknown>
		return `{${Object.keys(record)
			.sort()
			.filter((key) => record[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
			.join(',')}}`
	}
	return JSON.stringify(value) ?? 'null'
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim()
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export class BrowserStallGuard {
	private turn: string | undefined
	private readonly repeats = new Map<string, Repeat>()
	private address = ''
	private tree = ''
	private tabs = ''
	private idleActs = 0
	private lastEffect = ''

	/** One signature for what the page showed: address, tab set and whole-page tree. */
	private signature(): string {
		return `${this.address}\n${this.tabs}\n${this.tree}`
	}

	private reset(turnId: string): void {
		this.turn = turnId
		this.repeats.clear()
		this.idleActs = 0
	}

	/** Record what the host returned. Call it for every result, counted or not. */
	seen(result: BrowserResult, wholePage: boolean): void {
		const page: BrowserPageInfo | undefined =
			result.snapshot?.page ?? result.screenshot?.page ?? result.page
		if (page) this.address = `${page.url}|${page.tab}`
		if (result.tabs)
			this.tabs = result.tabs.map((tab) => `${tab.tab}${tab.active ? '*' : ''}`).join(',')
		if (result.snapshot && wholePage) this.tree = fnv1a(result.snapshot.text)
		this.lastEffect = oneLine(
			result.message ??
				(page
					? `the page is at ${page.url} titled ${JSON.stringify(oneLine(page.title, 80))}`
					: ''),
			200,
		)
	}

	/** Before a call: the refusal to return instead of running it, if it is the fifth in a row. */
	check(turnId: string, call: StalledCall): ToolResult | undefined {
		if (this.turn !== turnId) this.reset(turnId)
		if (!call.counts) return undefined
		const key = `${call.tool}:${canonical(call.input)}`
		const previous = this.repeats.get(key)
		const count = this.nextCount(previous, this.signature())
		if (count < STALL_REFUSE_AT) return undefined
		if (previous) previous.count = count
		const effect = previous?.last ? ` The last thing the page showed: ${previous.last}.` : ''
		return {
			success: false,
			output: '',
			error: `${call.tool}: refused. This same call has now been made ${count} times in a row and the page has not changed.${effect} Do something different: another element, a fresh snapshot to look for it, a scroll, a wait, or another page. If nothing works, tell the user what is blocking you.`,
			data: { code: 'browser_repeated_no_change', repeats: count },
		}
	}

	/** A repeat continues only when the last identical call changed nothing and the page is still as it left it. */
	private nextCount(previous: Repeat | undefined, from: string): number {
		return previous?.unchanged && previous.after === from ? previous.count + 1 : 1
	}

	/**
	 * Before a call runs, the signature it starts from. Pass it to
	 * {@link finish}, which compares it with the one after.
	 */
	begin(): string {
		return this.signature()
	}

	/** After a call: count it and add a note to the result when it has earned one. */
	finish(turnId: string, call: StalledCall, before: string, result: ToolResult): ToolResult {
		if (this.turn !== turnId) this.reset(turnId)
		if (!call.counts) return result
		const key = `${call.tool}:${canonical(call.input)}`
		const previous = this.repeats.get(key)
		const count = this.nextCount(previous, before)
		const after = this.signature()
		// Nothing was known before the first call, so learning the page is not a change.
		const unchanged = after === before || before.trim() === ''
		this.repeats.set(key, { count, after, unchanged, last: this.lastEffect })
		this.idleActs = unchanged ? this.idleActs + 1 : 0
		const notes: string[] = []
		if (count >= STALL_NOTE_AT) {
			notes.push(
				`Note: this same call has now run ${count} times in a row and the page has not changed. Repeating it again will not help; try something different (another element, a fresh snapshot, a scroll, a wait) or tell the user what is blocking you.`,
			)
		}
		if (this.idleActs > 0 && this.idleActs % NO_PROGRESS_NOTE_AFTER === 0) {
			notes.push(
				`Note: ${this.idleActs} calls in a row have brought no new address, page content or tab. Say what is blocking you and ask the user before trying more.`,
			)
		}
		if (notes.length === 0) return result
		const text = notes.join(' ')
		return result.success
			? { ...result, output: result.output ? `${text}\n${result.output}` : text }
			: { ...result, error: `${result.error ?? ''} ${text}`.trim() }
	}
}
