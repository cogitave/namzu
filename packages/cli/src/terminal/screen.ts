import serializePackage from '@xterm/addon-serialize'
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize'
import headlessPackage from '@xterm/headless'
import type { Terminal as TerminalType } from '@xterm/headless'

// Both packages are CommonJS bundles: Node's ES loader exposes only their default
// export, whatever a bundler or a test runner would let a named import do.
const { Terminal } = headlessPackage as unknown as { Terminal: typeof TerminalType }
const { SerializeAddon } = serializePackage as unknown as {
	SerializeAddon: typeof SerializeAddonType
}

/**
 * What a terminal looks like right now, kept by a headless emulator fed with the
 * same bytes the viewers get.
 *
 * Two readers need it: a viewer that attaches late or reloads (it restores the
 * serialized screen instead of replaying a megabyte of escape codes), and, later,
 * an agent that wants rendered text rather than a stream of control sequences.
 *
 * The emulator parses asynchronously. `offset()` is therefore the count of
 * characters the emulator has actually consumed, not the count handed to it, so a
 * snapshot always says exactly which output it already contains.
 */
export class HeadlessScreen {
	private readonly term: TerminalType
	private readonly serializer: SerializeAddonType
	private parsed = 0
	private fed = 0

	constructor(cols: number, rows: number, scrollback: number) {
		this.serializer = new SerializeAddon()
		this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
		this.term.loadAddon(this.serializer)
	}

	write(data: string): void {
		this.fed += data.length
		const upTo = this.fed
		this.term.write(data, () => {
			this.parsed = upTo
		})
	}

	/** Resolves once everything written so far has been parsed. */
	settled(): Promise<void> {
		return new Promise((resolve) => this.term.write('', () => resolve()))
	}

	resize(cols: number, rows: number): void {
		this.term.resize(cols, rows)
	}

	/** Output offset the serialized screen is exact for. */
	offset(): number {
		return this.parsed
	}

	/** The screen as escape sequences that rebuild it, within `maxLength`. */
	serialize(scrollback: number, maxLength: number): string {
		let out = this.serializer.serialize({ scrollback })
		if (out.length > maxLength) out = this.serializer.serialize({ scrollback: 0 })
		return out.length > maxLength ? '' : out
	}

	/** The visible rows as plain text, trailing blanks trimmed. */
	lines(): string[] {
		const buffer = this.term.buffer.active
		const rows: string[] = []
		for (let row = 0; row < this.term.rows; row++)
			rows.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
		return rows
	}

	dispose(): void {
		this.serializer.dispose()
		this.term.dispose()
	}
}
