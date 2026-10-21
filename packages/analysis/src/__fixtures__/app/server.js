'use strict'
const http = require('node:http')
const { verify } = require('./lib/auth.js')

const routes = {
	'/login': async (req) => {
		const token = req.headers.authorization
		if (!verify(token)) {
			throw new Error('Invalid token: refusing login')
		}
		return { ok: true }
	},
	'/health': () => ({ status: 'ok' }),
}

function dispatch(req) {
	const handler = routes[req.url]
	if (!handler) return { status: 404, body: 'Not found' }
	return handler(req)
}

http.createServer((req, res) => {
	Promise.resolve(dispatch(req)).then((out) => res.end(JSON.stringify(out)))
}).listen(8080)

module.exports = { dispatch }
