/**
 * The daemon's log: `schedule/daemon/log/daemon-YYYY-MM-DD.jsonl`, fourteen
 * days kept. Job names and ids only — never a prompt or a model's words; those
 * live in the run's session.
 */

import { appendFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { type LogSink, jsonLinesSink } from '@namzu/sdk'
import { PRIVATE_FILE_MODE, ensureDir } from '../store/atomic.js'

const KEEP_DAYS = 14

function day(now: Date): string {
	return now.toISOString().slice(0, 10)
}

export function daemonLogPath(dir: string, now = new Date()): string {
	return join(dir, `daemon-${day(now)}.jsonl`)
}

/** Remove daily files older than fourteen days. */
export function pruneDaemonLogs(dir: string, now = new Date()): void {
	let names: string[]
	try {
		names = readdirSync(dir)
	} catch {
		return
	}
	const cutoff = new Date(now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10)
	for (const name of names) {
		const match = /^daemon-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
		if (match && (match[1] as string) < cutoff) rmSync(join(dir, name), { force: true })
	}
}

/** A JSON-lines sink appending to today's file. */
export function daemonLogSink(dir: string, now: () => Date = () => new Date()): LogSink {
	ensureDir(dir)
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			try {
				appendFileSync(daemonLogPath(dir, now()), chunk, { mode: PRIVATE_FILE_MODE })
				callback()
			} catch (error) {
				callback(error as Error)
			}
		},
	})
	stream.on('error', () => {})
	return jsonLinesSink(stream as unknown as NodeJS.WritableStream)
}
