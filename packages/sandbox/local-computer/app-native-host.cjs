#!/usr/local/bin/node
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { installedApplication, applicationEnvironment } = require('./app-catalog.cjs')
const manifest = require('./new-tab/manifest.json')

const HOST_NAME = 'org.namzu.apps'
const extensionId = [
	...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16),
]
	.map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
	.join('')
const EXTENSION_ORIGIN = `chrome-extension://${extensionId}/`
const MAX_MESSAGE = 4096

function launcherMessage(message) {
	if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined
	const keys = Object.keys(message)
	if (message.type === 'list' && keys.length === 1) return { type: 'list' }
	if (
		message.type === 'launch' &&
		keys.length === 2 &&
		typeof message.appId === 'string' &&
		/^[a-z]{1,20}$/.test(message.appId)
	)
		return { type: 'launch', appId: message.appId }
	return undefined
}

function launchApplication(app, spawnProcess = spawn) {
	return new Promise((resolve) => {
		let child
		try {
			child = spawnProcess(app.binary, [...app.args], {
				cwd: '/home/namzu/workspace',
				env: applicationEnvironment(app),
				detached: true,
				shell: false,
				stdio: 'ignore',
			})
		} catch {
			resolve({ ok: false, error: 'launch_failed' })
			return
		}
		child.once('error', () => resolve({ ok: false, error: 'launch_failed' }))
		child.once('spawn', () => {
			child.unref()
			resolve({ ok: true, appId: app.id })
		})
	})
}

/** One bounded Chrome native message per host process. No guest HTTP port or token. */
async function handleMessage(message, options = {}) {
	const parsed = launcherMessage(message)
	if (!parsed) return { ok: false, error: 'invalid_request' }
	if (parsed.type === 'list') {
		try {
			const apps = JSON.parse(
				(options.readApps ?? (() => readFileSync(join(__dirname, 'new-tab/apps.json'), 'utf8')))(),
			)
			if (!Array.isArray(apps)) throw new Error('Invalid catalogue')
			return { ok: true, apps }
		} catch {
			return { ok: false, error: 'catalogue_unavailable' }
		}
	}
	const app = installedApplication(parsed.appId, options.access)
	if (!app) return { ok: false, error: 'application_unavailable' }
	return await launchApplication(app, options.spawn)
}

function writeMessage(output, message) {
	const body = Buffer.from(JSON.stringify(message), 'utf8')
	const header = Buffer.alloc(4)
	header.writeUInt32LE(body.length)
	output.end(Buffer.concat([header, body]))
}

function runNativeHost(origin, input = process.stdin, output = process.stdout) {
	if (origin !== EXTENSION_ORIGIN) {
		writeMessage(output, { ok: false, error: 'unauthorized_origin' })
		return
	}
	let body = Buffer.alloc(0)
	let size
	let settled = false
	const finish = (response) => {
		if (settled) return
		settled = true
		input.removeListener('data', receive)
		input.destroy()
		writeMessage(output, response)
	}
	const receive = (chunk) => {
		if (settled) return
		if (body.length + chunk.length > MAX_MESSAGE + 4) {
			finish({ ok: false, error: 'invalid_request' })
			return
		}
		body = Buffer.concat([body, chunk])
		if (body.length < 4) return
		if (size === undefined) size = body.readUInt32LE(0)
		if (size < 1 || size > MAX_MESSAGE || body.length > size + 4) {
			finish({ ok: false, error: 'invalid_request' })
			return
		}
		if (body.length !== size + 4) return
		let message
		try {
			message = JSON.parse(body.toString('utf8', 4))
		} catch {
			finish({ ok: false, error: 'invalid_request' })
			return
		}
		settled = true
		input.removeListener('data', receive)
		input.destroy()
		void handleMessage(message).then(
			(response) => writeMessage(output, response),
			() => writeMessage(output, { ok: false, error: 'launch_failed' }),
		)
	}
	input.on('data', receive)
	input.on('end', () => {
		if (!settled) finish({ ok: false, error: 'invalid_request' })
	})
	input.on('error', () => {
		if (!settled) finish({ ok: false, error: 'invalid_request' })
	})
}

module.exports = {
	EXTENSION_ORIGIN,
	HOST_NAME,
	MAX_MESSAGE,
	launcherMessage,
	launchApplication,
	handleMessage,
	runNativeHost,
}
if (require.main === module) runNativeHost(process.argv[2])
