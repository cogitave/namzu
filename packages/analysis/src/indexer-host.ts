/**
 * The process that parses.
 *
 * `oxc-parser` is native code, and on a handful of pathological inputs (a
 * 6,000-deep array, 20,000 chained ternaries, 100,000 `+` terms, 100,000
 * nested calls — all measured on 0.155.0, with raw transfer and without) it
 * dies with SIGSEGV. A segfault is not an exception: it cannot be caught, and a
 * worker thread shares the process it takes down. So parsing happens here, in a
 * child process the index owns, and the parent treats the child's death as one
 * file's failure.
 *
 * One request at a time. Before parsing, the child says which file it is on,
 * so the parent can name the culprit when the next thing it hears is an exit.
 * This module is the child's entry point and does nothing when imported by
 * anything that is not a forked child.
 */

import { ParserUnavailableError, parseSource, useParserModule } from './parse.js'
import { RowSink, indexProgram } from './walk.js'

export type HostRequest = {
	readonly t: 'parse'
	readonly rel: string
	readonly abs: string
	readonly text: string
}

export type HostReply =
	| { readonly t: 'ready' }
	| { readonly t: 'start'; readonly rel: string }
	| {
			readonly t: 'done'
			readonly rel: string
			readonly parseErrors: number
			readonly rows: import('./walk.js').RowsPayload
	  }
	| {
			readonly t: 'fail'
			readonly rel: string
			readonly error: string
			readonly unavailable?: true
	  }

async function handle(request: HostRequest): Promise<HostReply> {
	try {
		const parsed = await parseSource(request.abs, request.text)
		// Function ids are local to the file; the parent offsets them when it
		// writes, inside the transaction that owns the id counter.
		const sink = new RowSink(0)
		indexProgram(parsed.program as Parameters<typeof indexProgram>[0], sink)
		return {
			t: 'done',
			rel: request.rel,
			parseErrors: parsed.errors,
			rows: {
				functions: sink.functions,
				strings: sink.strings,
				calls: sink.calls,
				imports: sink.imports,
				exports: sink.exports,
			},
		}
	} catch (err) {
		return {
			t: 'fail',
			rel: request.rel,
			error: err instanceof Error ? err.message : String(err),
			...(err instanceof ParserUnavailableError ? { unavailable: true as const } : {}),
		}
	}
}

if (typeof process.send === 'function') {
	if (process.argv[2]) useParserModule(process.argv[2])
	const send = process.send.bind(process)
	process.on('message', (message: HostRequest) => {
		if (message?.t !== 'parse') return
		send({ t: 'start', rel: message.rel } satisfies HostReply)
		void handle(message).then((reply) => send(reply))
	})
	// The parent going away must take this process with it.
	process.on('disconnect', () => process.exit(0))
	send({ t: 'ready' } satisfies HostReply)
}
