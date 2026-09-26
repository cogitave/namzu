// A real stdio peer that interleaves progress for two concurrent tool calls.
let pending = ''
const calls = []
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
	pending += chunk
	let newline = pending.indexOf('\n')
	while (newline !== -1) {
		const line = pending.slice(0, newline)
		pending = pending.slice(newline + 1)
		if (line.trim()) {
			const request = JSON.parse(line)
			if (request.method === 'server/discover') {
				send({ jsonrpc: '2.0', id: request.id, result: {} })
			} else if (request.method === 'initialize') {
				send({
					jsonrpc: '2.0',
					id: request.id,
					result: {
						protocolVersion: '2024-11-05',
						serverInfo: { name: 'progress-peer' },
						capabilities: { tools: {} },
					},
				})
			} else if (request.method === 'tools/call') {
				calls.push(request)
				if (calls.length === 2) {
					const [first, second] = calls
					const tokenA = first.params._meta.progressToken
					const tokenB = second.params._meta.progressToken
					const progress = (progressToken, value, message) =>
						send({
							jsonrpc: '2.0',
							method: 'notifications/progress',
							params: { progressToken, progress: value, total: 2, message },
						})
					progress(tokenB, 1, 'second started')
					progress(tokenA, 1, 'first started')
					send({ jsonrpc: '2.0', id: first.id, result: { content: [] } })
					progress(tokenA, 2, 'late first update')
					progress(tokenB, 2, 'second done')
					send({ jsonrpc: '2.0', id: second.id, result: { content: [] } })
				}
			}
		}
		newline = pending.indexOf('\n')
	}
})
