// Built-in sinks. All three receive already-redacted, already-capped
// records — see redact.ts and caps.ts — so nothing here re-implements
// either concern; a sink's only job is to render.

import type { LogRecord, LogSink } from './types.js'

/**
 * Delivers nothing, by construction. `createLogger`'s dispatch identity-
 * checks the configured sink against this exact reference and counts the
 * record as dropped rather than calling `emit` — a no-op `emit` and a real
 * delivery both return `undefined`, so without the identity check nothing
 * downstream could ever tell "configured to discard" from "silently eating
 * every record".
 */
export const NOOP_SINK: LogSink = {
	emit() {},
}

/**
 * One JSON object per line — the canonical wire format for the machine-read
 * path (`namzu run-stream`'s stderr). JSON string-escaping neutralises
 * `\n`/`\r` by construction, closing the log-forging surface without a
 * single character-stripping call site, which is bypassable anyway.
 *
 * `JSON.stringify` leaves U+2028 and U+2029 literal in its output, and some
 * readers — older V8, some log shippers — treat either codepoint as a line
 * terminator regardless of the JSON quoting around it. Escaped here so a
 * record can never masquerade as two lines to a reader that split on them.
 */
export function jsonLinesSink(stream: NodeJS.WritableStream): LogSink {
	return {
		emit(record: LogRecord) {
			// U+2028/U+2029 built via fromCharCode rather than a \u escape in a
			// regex literal — either escape, typed directly, risks becoming the raw
			// codepoint again instead of the six characters of escape text; a raw
			// U+2028/U+2029 inside a regex literal is a LineTerminator to the JS
			// parser itself and fails to compile.
			const lineSeparator = String.fromCharCode(0x2028)
			const paragraphSeparator = String.fromCharCode(0x2029)
			const line = JSON.stringify(record)
				.split(lineSeparator)
				.join('\\u2028')
				.split(paragraphSeparator)
				.join('\\u2029')
			stream.write(`${line}\n`)
		},
	}
}

const SEVERITY_LABEL: Record<LogRecord['severityText'], string> = {
	debug: 'DEBUG',
	info: 'INFO',
	warn: 'WARN',
	error: 'ERROR',
}

// Every C0 control byte (0x00-0x1F) and DEL (0x7F) becomes its `\xNN`
// form — ESC included, so a full ANSI CSI/OSC sequence survives as inert,
// readable text (`\x1b[31m`) rather than as live bytes a terminal would
// act on. Deleting the escape byte outright was the first draft of this
// function and is worse: it silently drops information (nothing in the
// output says an escape sequence was even there) for no extra safety
// over converting it to text, since every OTHER control byte already gets
// the same visible treatment.
// `body` and `scope` reach this renderer as plain strings with no upstream
// guarantee yet that either is a constant (that lands with the CI gate in
// later work) — a remote MCP server that names itself an escape sequence
// erasing the previous line and printing a fake refusal is a real forging
// attempt against the terminal `namzu run` writes to today, not a
// hypothetical one.
// biome-ignore lint/suspicious/noControlCharactersInRegex: this pattern IS the control-character filter — the escapes below are ASCII text (`\x00`-`\x1F`, `\x7F`), not raw bytes pasted into the source.
const CONTROL_BYTE = /[\x00-\x1F\x7F]/g

// U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are not ASCII
// control bytes, so CONTROL_BYTE above never matches either — but both are
// LineTerminator characters to a reader that splits on them, the exact gap
// jsonLinesSink above documents and closes for its own NDJSON output.
// `JSON.stringify` does not escape either codepoint, so the attribute half
// of a record — which reaches this file as already-serialized JSON text,
// below — can still carry either straight through unescaped. Built via
// `fromCharCode` and plain `.split()/.join()` rather than a backslash-u
// escape in a regex literal, for the same reason jsonLinesSink's own
// separators are: typed directly, either escape risks becoming the raw
// codepoint again instead of the six characters of escape text, and a raw
// instance of either inside a regex literal is a LineTerminator to the JS
// parser itself and fails to compile.
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

function escapeForDisplay(text: string): string {
	return text
		.replace(CONTROL_BYTE, (byte) => `\\x${byte.charCodeAt(0).toString(16).padStart(2, '0')}`)
		.split(LINE_SEPARATOR)
		.join('\\u2028')
		.split(PARAGRAPH_SEPARATOR)
		.join('\\u2029')
}

/**
 * Human-readable line, one record per line. This is the foundation later
 * work builds the boot-narrative renderer on top of (the elapsed-time
 * column, the hashed scope column, per-event templates) — deliberately not
 * attempted here, since nothing in this increment reads any of those
 * columns yet.
 */
export function prettySink(stream: NodeJS.WritableStream): LogSink {
	return {
		emit(record: LogRecord) {
			const timestamp = new Date(record.timestamp).toISOString()
			const level = SEVERITY_LABEL[record.severityText]
			const scope = escapeForDisplay(record.scope.name)
			const body = escapeForDisplay(record.body)

			// JSON.stringify turns every ASCII control byte 0x00-0x1F — ESC
			// included — into literal `\uXXXX` text inside each attribute value,
			// but it does not touch DEL (0x7F) or U+2028/U+2029: none of the
			// three are in JSON's mandatory escape set, so all three used to
			// reach this stream exactly as JSON.stringify left them — DEL as a
			// raw byte, U+2028/U+2029 as raw codepoints — the same gap
			// jsonLinesSink already closed on its own path, just left open
			// here. Running escapeForDisplay over the already-serialized JSON
			// text closes it: every OTHER control byte JSON.stringify already
			// turned into backslash text has no raw byte left for the regex to
			// match, so this only ever touches the three it left behind.
			const attributeKeys = Object.keys(record.attributes)
			const attributes =
				attributeKeys.length > 0 ? ` ${escapeForDisplay(JSON.stringify(record.attributes))}` : ''

			stream.write(`[${timestamp}] [${level}] [${scope}] ${body}${attributes}\n`)
		},
	}
}
