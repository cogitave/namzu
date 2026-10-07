import { copyTextPayload } from '../shared/clipboard-text.js'

/** Four admitted writes, including the active one; newer copies finish last. */
export class ClipboardTextWriter {
	private pending = 0
	private tail: Promise<void> = Promise.resolve()
	constructor(private readonly writeText: (text: string) => Promise<void>) {}
	async copy(input: unknown): Promise<void> {
		const text = copyTextPayload(input)
		if (this.pending >= 4) throw new Error('Copy is busy. Try again.')
		this.pending++
		const operation = this.tail.catch(() => {}).then(() => this.writeText(text))
		this.tail = operation
		try {
			await operation
		} finally {
			this.pending--
		}
	}
}
