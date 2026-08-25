import { appendFileSync, readFileSync } from 'node:fs'

const markerPath = process.argv[2]
if (!markerPath) throw new Error('marker path required')

let launch = 1
try {
	launch += (readFileSync(markerPath, 'utf8').match(/^pid:/gm) ?? []).length
} catch (error) {
	if (error?.code !== 'ENOENT') throw error
}
appendFileSync(markerPath, `pid:${process.pid}:${launch}\n`)
let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
	buffer += chunk
	const lines = buffer.split('\n')
	buffer = lines.pop() ?? ''
	for (const line of lines) {
		if (!line.trim()) continue
		const message = JSON.parse(line)
		if (message.method === 'initialize') {
			process.stdout.write(
				`${JSON.stringify({
					jsonrpc: '2.0',
					id: message.id,
					result: {
						protocolVersion: '2024-11-05',
						serverInfo: { name: 'response-closer', version: '1' },
						capabilities: { tools: {} },
					},
				})}\n`,
			)
			continue
		}
		if (message.method === 'tools/list') {
			appendFileSync(markerPath, 'tools/list\n')
			if (launch === 1) {
				process.stdout.end()
			} else {
				process.stdout.write(
					`${JSON.stringify({
						jsonrpc: '2.0',
						id: message.id,
						result: { tools: [{ name: 'restored', inputSchema: { type: 'object' } }] },
					})}\n`,
				)
			}
		}
	}
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

// Keep the process alive after its response channel ends. The safety timer
// prevents a deliberately broken mutation from orphaning the fixture.
setInterval(() => {}, 1_000)
setTimeout(() => process.exit(70), 15_000).unref()
