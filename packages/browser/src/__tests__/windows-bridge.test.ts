import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WINDOWS_BRIDGE_SCRIPT } from '../windows-bridge-script.js'
import {
	LineSplitter,
	WindowsBridgeError,
	type WindowsBridgeParams,
	WindowsCdpBridge,
	bridgeArguments,
	bridgeScript,
	encodePowerShellCommand,
	parseDevToolsActivePort,
} from '../windows-bridge.js'

const PARAMS: WindowsBridgeParams = {
	executable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	profile: 'work',
	userDataDir: 'C:\\Users\\O\'Brien "x"\\AppData\\Local\\namzu\\browser\\profiles\\work',
	headless: true,
	closeOnExit: true,
	launchTimeoutMs: 30_000,
}

describe('the PowerShell command line', () => {
	it('is the script as UTF-16LE, base64', () => {
		const script = "Write-Output 'ünïcödé'"
		const encoded = encodePowerShellCommand(script)
		expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(script)
		expect(Buffer.from(encoded, 'base64').length).toBe(script.length * 2)
	})

	it('embeds the parameters as base64 JSON, so no quote reaches the parser', () => {
		const script = bridgeScript(PARAMS)
		expect(script).not.toContain('__NAMZU_BRIDGE_PARAMS__')
		expect(script).not.toContain("O'Brien")
		const embedded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)?.[1] ?? ''
		expect(JSON.parse(Buffer.from(embedded, 'base64').toString('utf8'))).toEqual(PARAMS)
	})

	it('runs without a profile, non-interactively, within the Windows command-line limit', () => {
		const args = bridgeArguments(PARAMS)
		expect(args.slice(0, -1)).toEqual([
			'-NoLogo',
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-EncodedCommand',
		])
		const decoded = Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le')
		expect(decoded).toBe(bridgeScript(PARAMS))
		// CreateProcess refuses a command line over 32 767 characters.
		expect(args.join(' ').length + 100).toBeLessThan(32_767)
	})

	it('closes only a browser it started, and only by the id it got back', () => {
		expect(WINDOWS_BRIDGE_SCRIPT).toContain('$launched -and $closeOnExit')
		expect(WINDOWS_BRIDGE_SCRIPT).toContain('Stop-Process -Id $proc.Id')
		expect(WINDOWS_BRIDGE_SCRIPT).not.toMatch(/Stop-Process -Name|taskkill|Get-Process\s+chrome/i)
		expect(WINDOWS_BRIDGE_SCRIPT).toContain('--remote-debugging-port=0')
		expect(WINDOWS_BRIDGE_SCRIPT).toContain("'ws://127.0.0.1:'")
	})
})

describe('parseDevToolsActivePort', () => {
	it('reads the port and the browser target', () => {
		expect(
			parseDevToolsActivePort('53412\n/devtools/browser/0b1c2d3e-aaaa-bbbb-cccc-0123456789ab'),
		).toEqual({
			port: 53412,
			path: '/devtools/browser/0b1c2d3e-aaaa-bbbb-cccc-0123456789ab',
		})
		expect(parseDevToolsActivePort('9222\r\n/devtools/browser/abc\r\n')).toEqual({
			port: 9222,
			path: '/devtools/browser/abc',
		})
	})

	it('refuses anything else', () => {
		expect(parseDevToolsActivePort(undefined)).toBeUndefined()
		expect(parseDevToolsActivePort('')).toBeUndefined()
		expect(parseDevToolsActivePort('9222')).toBeUndefined()
		expect(parseDevToolsActivePort('0\n/devtools/browser/abc')).toBeUndefined()
		expect(parseDevToolsActivePort('70000\n/devtools/browser/abc')).toBeUndefined()
		expect(parseDevToolsActivePort('9222\n/devtools/page/abc')).toBeUndefined()
		expect(parseDevToolsActivePort('9222\n/devtools/browser/../../x')).toBeUndefined()
		expect(parseDevToolsActivePort('x9222\n/devtools/browser/abc')).toBeUndefined()
	})
})

describe('LineSplitter', () => {
	const collect = () => {
		const lines: string[] = []
		return { lines, splitter: new LineSplitter((line) => lines.push(line.toString('utf8'))) }
	}

	it('cuts at newlines across chunk boundaries and drops a trailing CR', () => {
		const { lines, splitter } = collect()
		splitter.push(Buffer.from('{"a":1}\n{"b"'))
		splitter.push(Buffer.from(':2}\r\n\n{"c":'))
		expect(lines).toEqual(['{"a":1}', '{"b":2}', ''])
		expect(splitter.buffered).toBe(5)
		splitter.push(Buffer.from('3}\n'))
		expect(lines.at(-1)).toBe('{"c":3}')
		expect(splitter.buffered).toBe(0)
	})

	it('keeps a multi-byte character split between chunks', () => {
		const { lines, splitter } = collect()
		const bytes = Buffer.from('{"t":"çok güzel 🌍"}\n')
		for (const byte of bytes) splitter.push(Buffer.from([byte]))
		expect(lines).toEqual(['{"t":"çok güzel 🌍"}'])
	})

	it('reassembles an 8 MB line from odd-sized chunks', () => {
		const { lines, splitter } = collect()
		const data = randomBytes(6 * 1024 * 1024).toString('base64')
		const message = JSON.stringify({ id: 7, result: { data } })
		const stream = Buffer.from(`${message}\n{"id":8}\n`)
		let at = 0
		let size = 1
		while (at < stream.length) {
			splitter.push(stream.subarray(at, at + size))
			at += size
			size = (size * 7 + 13) % 300_000 || 1
		}
		expect(lines).toHaveLength(2)
		expect(lines[0]?.length).toBe(message.length)
		expect(lines[0] === message).toBe(true)
		expect(lines[1]).toBe('{"id":8}')
	})
})

/**
 * A stand-in for powershell.exe speaking the bridge's line protocol: says
 * `ready` (or an error), echoes every `{…}` line back as `{"echo":…}`, and
 * reports `@namzu keep` in its exit line.
 */
const FAKE_BRIDGE = String.raw`
const mode = process.argv[1]
if (mode === 'error') {
	process.stdout.write('noise from the profile\n@namzu {"type":"error","code":"browser-exited","message":"The browser exited."}\n')
	process.exit(1)
}
if (mode === 'silent-exit') { process.stderr.write('The term x is not recognized'); process.exit(3) }
process.stdout.write('@namzu {"type":"ready","userDataDir":"C:\\\\p","port":9222,"path":"/devtools/browser/x","launched":true,"pid":42,"localAppData":"C:\\\\L"}\n')
let keep = false
let buffer = ''
process.stdin.on('data', (chunk) => {
	buffer += chunk
	let at
	while ((at = buffer.indexOf('\n')) !== -1) {
		const line = buffer.slice(0, at)
		buffer = buffer.slice(at + 1)
		if (line === '@namzu keep') keep = true
		else if (line.startsWith('{')) process.stdout.write('{"echo":' + line + '}\n')
	}
})
process.stdin.on('end', () => {
	process.stdout.write('@namzu {"type":"exit","keep":' + keep + '}\n', () => process.exit(0))
})
`

function fake(mode: string) {
	return () =>
		spawn(process.execPath, ['-e', FAKE_BRIDGE, mode], { stdio: ['pipe', 'pipe', 'pipe'] })
}

describe('WindowsCdpBridge', () => {
	it('reads ready, and relays messages both ways, a large one intact', async () => {
		const bridge = await WindowsCdpBridge.start({
			powershell: 'powershell.exe',
			params: PARAMS,
			env: {},
			spawnProcess: fake('ok'),
		})
		expect(bridge.ready).toMatchObject({
			port: 9222,
			launched: true,
			pid: 42,
			userDataDir: 'C:\\p',
		})
		const received: string[] = []
		let wake: () => void = () => undefined
		bridge.onMessage((message) => {
			received.push(message.toString('utf8'))
			wake()
		})
		const until = (n: number) =>
			new Promise<void>((resolve) => {
				wake = () => received.length >= n && resolve()
				wake()
			})
		const data = randomBytes(3 * 1024 * 1024).toString('base64')
		bridge.send('{"id":1}')
		bridge.send(Buffer.from(JSON.stringify({ id: 2, params: { data } })))
		// Pretty-printed JSON is legal and would break the framing: re-serialised.
		bridge.send('{\n  "id": 3\n}')
		await until(3)
		expect(received[0]).toBe('{"echo":{"id":1}}')
		expect(JSON.parse(received[1] ?? '').echo.params.data).toBe(data)
		expect(received[2]).toBe('{"echo":{"id":3}}')
		bridge.keepBrowser()
		await bridge.stop()
		expect(bridge.alive).toBe(false)
		expect(bridge.send('{"id":4}')).toBe(false)
	})

	it('reports the bridge script refusal', async () => {
		const start = WindowsCdpBridge.start({
			powershell: 'powershell.exe',
			params: PARAMS,
			env: {},
			spawnProcess: fake('error'),
		})
		await expect(start).rejects.toBeInstanceOf(WindowsBridgeError)
		await expect(start).rejects.toMatchObject({ code: 'browser-exited' })
	})

	it('reports an exit before ready with what PowerShell said', async () => {
		await expect(
			WindowsCdpBridge.start({
				powershell: 'powershell.exe',
				params: PARAMS,
				env: {},
				spawnProcess: fake('silent-exit'),
			}),
		).rejects.toThrow(/exited \(code 3\).*not recognized/)
	})

	it('reports a powershell.exe that cannot be started', async () => {
		await expect(
			WindowsCdpBridge.start({
				powershell: '/nonexistent/powershell.exe',
				params: PARAMS,
				env: {},
			}),
		).rejects.toMatchObject({ code: 'spawn-failed' })
	})
})
