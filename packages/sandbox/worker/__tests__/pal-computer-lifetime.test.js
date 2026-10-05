import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

function replaceUnique(source, anchor, replacement) {
	if (source.split(anchor).length !== 2) throw new Error(`Expected one source anchor: ${anchor}`)
	return source.replace(anchor, replacement)
}

function mailbox() {
	const received = []
	const waiters = []
	return {
		push(message) {
			const index = waiters.findIndex((waiter) => waiter.type === message.type)
			if (index === -1) received.push(message)
			else waiters.splice(index, 1)[0].resolve(message)
		},
		next(type) {
			const index = received.findIndex((message) => message.type === type)
			if (index !== -1) return Promise.resolve(received.splice(index, 1)[0])
			return new Promise((resolve) => waiters.push({ type, resolve }))
		},
	}
}

// Real guest processes report readiness and accept explicit shutdown over a
// test-owned socket. Outcomes never depend on a sleep or a wall-clock deadline.
const applicationFixture = [
	"const {spawn} = require('node:child_process')",
	"const {createConnection} = require('node:net')",
	'const role = process.argv[2]',
	'const socket = createConnection({host: "127.0.0.1", port: Number(process.argv[3])})',
	'let application',
	'if (role === "leader") {',
	'  application = spawn(process.execPath, [__filename, "application", process.argv[3]], {stdio: "ignore"})',
	'  process.on("SIGTERM", () => {',
	'    if (application.exitCode !== null || application.signalCode !== null) process.exit(0)',
	'    else application.once("close", () => process.exit(0))',
	'  })',
	'}',
	'socket.on("connect", () => {socket.write(JSON.stringify({type: role, pid: process.pid}) + "\\n"); if(role === "leader") console.log("LEADER_READY")})',
	'let buffer = ""',
	'socket.on("data", (chunk) => {',
	'  buffer += chunk.toString("utf8")',
	'  for (;;) {',
	'    const index = buffer.indexOf("\\n")',
	'    if (index < 0) break',
	'    const command = buffer.slice(0, index)',
	'    buffer = buffer.slice(index + 1)',
	'    if (command === "EXIT0") process.exit(0)',
	'    if (command === "EXIT7") process.exit(7)',
	'    if (command === "SIGNAL") {process.removeAllListeners("SIGTERM"); process.kill(process.pid, "SIGTERM")}',
	'    if (command === "PING") socket.write(JSON.stringify({type: "alive", pid: process.pid}) + "\\n")',
	'  }',
	'})',
	'socket.on("close", () => process.exit(0))',
	'socket.on("error", () => process.exit(1))',
].join('\n')

async function fixture(options = {}) {
	const directory = await mkdtemp(path.join(tmpdir(), 'namzu-pal-worker-policy-'))
	const events = mailbox()
	const commands = mailbox()
	const applications = new Set()
	const server = createServer((socket) => {
		applications.add(socket)
		let buffer = ''
		socket.on('error', () => {})
		socket.on('close', () => applications.delete(socket))
		socket.on('data', (chunk) => {
			buffer += chunk.toString('utf8')
			for (;;) {
				const index = buffer.indexOf('\n')
				if (index === -1) break
				const message = JSON.parse(buffer.slice(0, index))
				buffer = buffer.slice(index + 1)
				commands.push({ ...message, socket })
			}
		})
	})
	const application = path.join(directory, 'application.cjs')
	await writeFile(application, applicationFixture)
	let source = await readFile(path.join(import.meta.dirname, '..', 'server.js'), 'utf8')
	source = replaceUnique(
		source,
		'async function confirmExitedProcessGroup(execution) {',
		[
			'async function confirmExitedProcessGroup(execution) {',
			'  process.send({type: "before-close", executionId: execution.executionId})',
			options.pauseClose ? '  await namzuTestContinueClose' : '',
		].join('\n'),
	)
	source = replaceUnique(
		source,
		'async function terminateAndConfirm(execution, cause) {',
		'async function terminateAndConfirm(execution, cause) {\n if(execution.state === "exited") process.send({type: "cancel-exited", cause})',
	)
	source = replaceUnique(
		source,
		'execution.exitSignal = signal',
		'execution.exitSignal = signal\n process.send({type: "leader-exit", exitCode, signal})',
	)
	if (options.pauseClose)
		source = replaceUnique(
			source,
			'async function waitForDone(execution, deadlineAt) {',
			// The copied worker waits for the explicit close gate, rather than a
			// deadline. Zero group-confirmation budget below makes a live group
			// an immediate refusal, without racing close against wall time.
			'async function waitForDone(execution, deadlineAt) {\n return await execution.done',
		)
	if (options.manualTimeout)
		source = replaceUnique(
			source,
			'const timeout = setTimeout(() => {',
			'const timeout = namzuTestCommandTimeout(() => {',
		)
	source = [
		'let namzuTestCloseResolve',
		'const namzuTestContinueClose = new Promise((resolve) => {namzuTestCloseResolve = resolve})',
		'let namzuTestTimeout',
		'function namzuTestCommandTimeout(callback) {',
		'  namzuTestTimeout = callback',
		'  return setTimeout(() => {}, 2147000000)',
		'}',
		'process.on("message", (message) => {',
		'  if (message.type === "continue-close") namzuTestCloseResolve()',
		'  if (message.type === "timeout") namzuTestTimeout()',
		'})',
		'const namzuTestKill = process.kill',
		'process.kill = function(pid, signal) {',
		'  if (signal !== 0) process.send({type: "group-signal", pid, signal})',
		'  return namzuTestKill.call(process, pid, signal)',
		'}',
		source,
	].join('\n')
	const entry = path.join(directory, 'worker.cjs')
	await writeFile(entry, source)
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const controlPort = server.address().port
	const child = spawn(process.execPath, [entry], {
		env: {
			...process.env,
			NAMZU_SANDBOX_PORT: '0',
			NAMZU_SANDBOX_BIND: '127.0.0.1',
			NAMZU_SANDBOX_WORKSPACE: directory,
			NAMZU_SANDBOX_IDLE_TIMEOUT_MS: '0',
			NAMZU_SANDBOX_NORMAL_EXIT_POLICY: options.policy ?? 'computer-lifetime',
			...(options.confirmMs === undefined
				? {}
				: { NAMZU_SANDBOX_CANCEL_CONFIRM_TIMEOUT_MS: String(options.confirmMs) }),
		},
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
	})
	const exited = once(child, 'exit')
	const signals = []
	child.on('message', (message) => {
		if (message.type === 'group-signal') signals.push(message)
		events.push(message)
	})
	let diagnostic = ''
	child.stderr.on('data', (chunk) => {
		diagnostic += chunk.toString('utf8')
	})
	const listening = new Promise((resolve, reject) => {
		let output = ''
		child.stdout.on('data', (chunk) => {
			output += chunk.toString('utf8')
			const match = output.match(/listening on 127\.0\.0\.1:(\d+) workspace=/)
			if (match) resolve(Number(match[1]))
		})
		child.once('error', reject)
		child.once('exit', (code) => reject(new Error(`Worker startup failed: ${code}${diagnostic}`)))
	})
	const port = await listening
	const baseUrl = `http://127.0.0.1:${port}`
	const post = (route, body) =>
		fetch(baseUrl + route, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})
	return {
		child,
		events,
		signals,
		post,
		exited,
		diagnostic: () => diagnostic,
		async begin(normalExitPolicy = 'computer-lifetime') {
			const reservation = await post('/executions/reserve', {})
			const lease = await reservation.json()
			const response = await post('/execute', {
				executionId: lease.executionId,
				command: process.execPath,
				args: [application, 'leader', String(controlPort)],
				...(normalExitPolicy === null ? {} : { normalExitPolicy }),
			})
			expect(response.status).toBe(200)
			const text = response.text().then(
				(value) => ({ value }),
				(error) => ({ error }),
			)
			const leader = await commands.next('leader')
			const app = await commands.next('application')
			return { id: lease.executionId, text, leader, app }
		},
		async alive(app) {
			app.socket.write('PING\n')
			expect((await commands.next('alive')).pid).toBe(app.pid)
		},
		async close() {
			// These sockets belong only to fixture applications. Their close handler
			// exits the applications, so no reused numeric PID needs to be signalled.
			const closed = [...applications].map((socket) => once(socket, 'close'))
			for (const socket of applications) socket.destroy()
			await Promise.all(closed)
			await new Promise((resolve) => server.close(resolve))
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
			await exited
			await rm(directory, { recursive: true, force: true })
		},
	}
}

describe.skipIf(process.platform !== 'linux')('exclusive computer application lifetime', () => {
	let computer
	afterEach(async () => {
		await computer?.close()
		computer = undefined
	})

	it('hands off a successful launcher while its app survives, then admits another command', async () => {
		computer = await fixture()
		const command = await computer.begin()
		command.leader.socket.write('EXIT0\n')
		const result = await command.text
		expect(result.error).toBeUndefined()
		expect(result.value).toContain('"exitCode":0')
		await computer.alive(command.app)
		expect(computer.signals).toEqual([])
		const second = await computer.post('/execute', {
			command: process.execPath,
			args: ['-e', 'console.log("next command")'],
			normalExitPolicy: 'computer-lifetime',
		})
		expect(await second.text()).toContain('next command')
		const terminal = await computer.post('/cancel', { executionId: command.id })
		expect(await terminal.json()).toMatchObject({ state: 'completed', result: { exitCode: 0 } })
		await computer.alive(command.app)
	})

	it.each(['strict', null])(
		'keeps image-only requests strict with request policy %s',
		async (policy) => {
			computer = await fixture()
			// null selects the genuinely absent field, not a nullable wire value.
			const command = await computer.begin(policy)
			command.leader.socket.write('EXIT0\n')
			expect((await command.text).error).toBeDefined()
			expect((await computer.exited)[0]).toBe(1)
			expect(computer.diagnostic()).toContain('remained live after its leader exited')
		},
	)

	it.each(['EXIT7', 'SIGNAL'])(
		'refuses application handoff on unsuccessful leader close: %s',
		async (close) => {
			computer = await fixture()
			const command = await computer.begin()
			command.leader.socket.write(`${close}\n`)
			expect((await command.text).error).toBeDefined()
			expect((await computer.exited)[0]).toBe(1)
			expect(computer.diagnostic()).toContain('remained live after its leader exited')
		},
	)

	it('keeps foreground cancellation owned and confirms its group before returning', async () => {
		computer = await fixture()
		const command = await computer.begin()
		const applicationClosed = once(command.app.socket, 'close')
		const cancellation = await computer.post('/cancel', { executionId: command.id })
		expect(await cancellation.json()).toMatchObject({ state: 'cancelled', started: true })
		await applicationClosed
		expect((await command.text).value).toContain('"timedOut":false')
		expect(computer.signals).toMatchObject([{ signal: 'SIGTERM' }])
	})

	it('keeps foreground timeout owned instead of handing off applications', async () => {
		computer = await fixture({ manualTimeout: true })
		const command = await computer.begin()
		const applicationClosed = once(command.app.socket, 'close')
		computer.child.send({ type: 'timeout' })
		await applicationClosed
		expect((await command.text).value).toContain('"timedOut":true')
		expect(computer.signals).toMatchObject([{ signal: 'SIGTERM' }])
	})

	it.each(['cancel', 'timeout'])(
		'fences %s after leader exit and before normal-close handoff',
		async (kind) => {
			// The copied drain wait is controlled by the close gate; zero group
			// confirmation budget forces a surviving app to be refused immediately.
			computer = await fixture({ pauseClose: true, manualTimeout: true, confirmMs: 0 })
			const command = await computer.begin()
			command.leader.socket.write('EXIT0\n')
			await computer.events.next('leader-exit')
			await computer.events.next('before-close')
			let cancellation
			if (kind === 'cancel')
				cancellation = computer.post('/cancel', { executionId: command.id }).then(
					(response) => ({ response }),
					(error) => ({ error }),
				)
			else computer.child.send({ type: 'timeout' })
			expect((await computer.events.next('cancel-exited')).cause).toBe(
				kind === 'cancel' ? 'cancelled' : 'timeout',
			)
			computer.child.send({ type: 'continue-close' })
			expect((await command.text).error).toBeDefined()
			expect((await computer.exited)[0]).toBe(1)
			if (cancellation) {
				const refusal = await cancellation
				expect(refusal.error !== undefined || refusal.response.status === 504).toBe(true)
			}
			expect(computer.signals).toEqual([])
			await computer.alive(command.app)
		},
	)

	it('rejects missing capability and invalid policy before command admission', async () => {
		computer = await fixture({ policy: 'strict' })
		const reservation = await computer.post('/executions/reserve', {})
		const lease = await reservation.json()
		expect(lease.normalExitPolicy).toBe('strict')
		const command = {
			executionId: lease.executionId,
			command: process.execPath,
			args: ['-e', 'console.log("only accepted command")'],
		}
		const unavailable = await computer.post('/execute', {
			...command,
			normalExitPolicy: 'computer-lifetime',
		})
		expect(unavailable.status).toBe(400)
		expect(await unavailable.json()).toEqual({ error: 'computer_lifetime_not_enabled' })
		for (const invalid of [null, '', 'other', true]) {
			const rejected = await computer.post('/execute', { ...command, normalExitPolicy: invalid })
			expect(rejected.status).toBe(400)
			expect(await rejected.json()).toEqual({ error: 'invalid_normal_exit_policy' })
		}
		const accepted = await computer.post('/execute', command)
		expect(accepted.status).toBe(200)
		expect(await accepted.text()).toContain('only accepted command')
	})
})
