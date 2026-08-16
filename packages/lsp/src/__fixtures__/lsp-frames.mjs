/**
 * The framing half of a language server, shared by the stubs beside it.
 *
 * Extracted because the alternative was a `node -e` one-liner per stub, and
 * three layers of escaping between a test file and a child process is a
 * place where the stub silently fails to start and the test reads as a
 * behaviour it never exercised. One of them did exactly that.
 */

export function serve(handle) {
	let buffer = Buffer.alloc(0)
	process.stdin.on('data', (chunk) => {
		buffer = Buffer.concat([buffer, chunk])
		for (;;) {
			const headerEnd = buffer.indexOf('\r\n\r\n')
			if (headerEnd === -1) return
			const match = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('utf8'))
			if (!match) {
				buffer = buffer.subarray(headerEnd + 4)
				continue
			}
			const length = Number(match[1])
			const start = headerEnd + 4
			if (buffer.length < start + length) return
			const body = buffer.subarray(start, start + length).toString('utf8')
			buffer = buffer.subarray(start + length)
			let message
			try {
				message = JSON.parse(body)
			} catch {
				continue
			}
			handle(message, send)
		}
	})
}

export function send(payload) {
	const body = Buffer.from(JSON.stringify(payload), 'utf8')
	process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
	process.stdout.write(body)
}
