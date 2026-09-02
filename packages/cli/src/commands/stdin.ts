/**
 * Piped input, read without being held hostage by it.
 *
 * Both headless commands read stdin when it is not a terminal: `run` for
 * material the prompt is about, `run-stream` for an optional message
 * history. `run` learned the hard way that "not a terminal" does not mean
 * "will end": the reader lived here first and `run-stream` kept its own
 * unconditional `for await` over stdin — so a host that spawned it with a
 * pipe it never closed (a background task, a CI step, a UI that forgot)
 * waited forever before the first log line after boot, with nothing on
 * either side to say why. One reader now, and `run-stream` always takes
 * the deadline: its history is optional, so silence means none.
 */

/**
 * How long to wait for the FIRST byte of piped input when the prompt was
 * already given as an argument.
 *
 * Once a byte arrives the read runs to end-of-input with no deadline, so a
 * slow or large producer is never truncated. The bound only covers the case
 * where nothing is coming at all.
 *
 * It exists because "is anything being piped in?" is not answerable without
 * reading: on Windows a real pipe, an inherited-but-idle pipe, and a test
 * runner's stdin are indistinguishable to `fstat` — all three report neither
 * FIFO nor file. Measured. So a command that unconditionally waited for
 * end-of-input would hang forever whenever stdin was open and silent, which is
 * the ordinary state of a CI step or a test process. Waiting a quarter second
 * is invisible to a person and instant for a pipe that has data ready.
 */
const FIRST_BYTE_DEADLINE_MS = 250

export async function readStdin(opts: { readonly deadline?: boolean } = {}): Promise<string> {
	// Capture once. Tests and embedded hosts can replace the process getter;
	// registration, observation and cleanup must still concern one stream.
	const input = process.stdin
	if (input.isTTY) return ''
	const chunks: Buffer[] = []
	const collect = async (): Promise<void> => {
		for await (const chunk of input) chunks.push(chunk as Buffer)
	}
	if (!opts.deadline) {
		await collect()
		return Buffer.concat(chunks).toString('utf8')
	}
	let timer: NodeJS.Timeout | undefined
	let settleFirstByte: (() => void) | undefined
	const firstByte = new Promise<void>((resolve) => {
		settleFirstByte = resolve
		timer = setTimeout(settleFirstByte, FIRST_BYTE_DEADLINE_MS)
		input.once('readable', settleFirstByte)
		input.once('end', settleFirstByte)
	})
	try {
		await firstByte
	} finally {
		if (timer) clearTimeout(timer)
		if (settleFirstByte) {
			input.removeListener('readable', settleFirstByte)
			input.removeListener('end', settleFirstByte)
		}
	}
	if (input.readableEnded || input.readableLength > 0) await collect()
	return Buffer.concat(chunks).toString('utf8')
}
