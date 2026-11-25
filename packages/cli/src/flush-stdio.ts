// Before the process exits after a command, hand everything written to stdout and stderr to the
// operating system. A pipe is non-blocking on some platforms, so a large write is queued inside the
// stream and `process.exit` drops whatever is still queued: a reader on the far end of a pipe saw
// the output cut at the pipe's buffer size (64 KB) while the same command redirected to a file was
// whole.

type Sink = Pick<NodeJS.WriteStream, 'write' | 'once' | 'on' | 'removeListener'> & {
	readonly writableLength: number
	readonly destroyed: boolean
}

function drained(stream: Sink): Promise<void> {
	// Nothing queued (a terminal, a file, a pipe that took it all at once) costs nothing: the TUI's
	// exit is not slowed.
	if (stream.destroyed || stream.writableLength === 0) return Promise.resolve()
	return new Promise<void>((resolve) => {
		// A reader that has gone surfaces as EPIPE on the stream, and nobody else is listening by now.
		// It means the output has nowhere to go, so leave at once.
		const done = (): void => {
			stream.removeListener('error', done)
			stream.removeListener('close', done)
			resolve()
		}
		stream.once('error', done)
		stream.once('close', done)
		// An empty write completes after every earlier write has been handed over.
		stream.write('', done)
	})
}

/** Resolve once stdout and stderr hold nothing queued, or at once when a reader has gone. Never rejects. */
export async function flushStdio(
	streams: readonly Sink[] = [process.stdout, process.stderr],
): Promise<void> {
	// The process is leaving: a reader that has gone is an EPIPE nobody can act on, and an error
	// event with no listener would turn it into a crash that replaces the command's exit code.
	for (const s of streams) s.on('error', () => undefined)
	await Promise.all(streams.map((s) => drained(s).catch(() => undefined)))
}
