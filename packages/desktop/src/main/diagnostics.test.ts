import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
	DesktopDiagnostics,
	desktopFailure,
	desktopStderrDetails,
	observeDesktopIpc,
	observeRendererConsole,
} from './diagnostics.js'

const roots: string[] = []
function create(now?: () => number) {
	const root = mkdtempSync(join(tmpdir(), 'namzu-desktop-diagnostics-'))
	roots.push(root)
	return { root, sink: new DesktopDiagnostics(root, now) }
}
function records(sink: DesktopDiagnostics) {
	return readFileSync(sink.path, 'utf8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line))
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('records a caught IPC rejection with its method and correlation without retaining error content', async () => {
	const { sink } = create()
	const error = new Error(
		'A local Docker engine running Linux containers and image are required. Bearer SECRET_TOKEN; prompt="private user body"; C:\\Users\\Private\\keys.txt',
	)
	await expect(
		observeDesktopIpc(
			sink,
			'startPalComputer',
			async () => {
				throw error
			},
			42,
		),
	).rejects.toBe(error)
	expect(records(sink)).toMatchObject([
		{
			eventName: 'namzu.desktop.ipc_failed',
			body: 'Desktop operation failed',
			attributes: {
				'namzu.desktop.operation': 'startPalComputer',
				'namzu.desktop.request': 42,
				'namzu.desktop.failure.reason': 'docker-engine-or-image-required',
			},
		},
	])
	const text = readFileSync(sink.path, 'utf8')
	for (const privateText of ['SECRET_TOKEN', 'private user body', 'Private', 'keys.txt', 'Bearer'])
		expect(text).not.toContain(privateText)
})

it('recognizes actionable catalogue, machine and OS failures without persisting arbitrary attributes', () => {
	const { sink } = create()
	sink.record('cli_stderr', {
		error: Object.assign(new Error('spawn /private/path ENOENT apiKey=PRIVATE'), {
			code: 'ENOENT',
		}),
		operation: 'namzu/providers/models',
		connection: '12345678-1234-1234-1234-123456789abc',
		request: 3,
	})
	sink.record('cli_notice', {
		error: 'The provider catalogue could not be loaded. rawResult=PRIVATE',
	})
	sink.record('ipc_failed', {
		error: 'The selected Podman machine is stopped or unavailable; start it explicitly',
	})
	expect(records(sink).map((record) => record.attributes['namzu.desktop.failure.reason'])).toEqual([
		'os-error',
		'model-catalogue-unavailable',
		'podman-machine-stopped',
	])
	expect(records(sink)[0].attributes).toMatchObject({
		'namzu.desktop.failure.code': 'ENOENT',
		'namzu.desktop.connection': '12345678-1234-1234-1234-123456789abc',
		'namzu.desktop.request': 3,
	})
	expect(readFileSync(sink.path, 'utf8')).not.toContain('PRIVATE')
	expect(desktopFailure({ message: 'SECRET', code: 'SECRET_CODE', stack: 'SECRET_STACK' })).toEqual(
		{ reason: 'unclassified', type: 'Unknown' },
	)
})

it('keeps genuine structured and pretty INFO stderr informational without failure attributes', () => {
	const { sink } = create()
	const structured = JSON.stringify({
		timestamp: 1,
		observedTimestamp: 1,
		severityText: 'info',
		severityNumber: 9,
		body: 'JSON catalogue ready; ACP protocol server started',
		scope: { name: 'cli' },
		resource: { 'service.name': 'namzu' },
		attributes: { private: 'PRIVATE_STDERR_ATTRIBUTE' },
	})
	sink.record('cli_stderr', desktopStderrDetails(structured))
	sink.record(
		'cli_stderr',
		desktopStderrDetails('[2026-10-02T09:00:00.000Z] [INFO] [cli] ACP protocol server started'),
	)
	for (const record of records(sink)) {
		expect(record.severityText).toBe('info')
		expect(record.severityNumber).toBe(9)
		expect(record.attributes).not.toHaveProperty('namzu.desktop.failure.reason')
	}
	expect(readFileSync(sink.path, 'utf8')).not.toContain('PRIVATE_STDERR_ATTRIBUTE')
	expect(desktopFailure('JSON catalogue ready')).toMatchObject({ reason: 'unclassified' })
	expect(desktopFailure('ACP protocol server started')).toMatchObject({ reason: 'unclassified' })
	expect(desktopFailure('Invalid Namzu protocol response.')).toMatchObject({
		reason: 'protocol-invalid',
	})
	expect(desktopFailure('Unexpected token in response; not valid JSON')).toMatchObject({
		reason: 'protocol-invalid',
	})
})

it('preserves real structured stderr severity and treats unrecognized output as a warning', () => {
	const { sink } = create()
	for (const [severity, severityNumber] of [
		['debug', 5],
		['warn', 13],
		['error', 17],
	] as const)
		sink.record(
			'cli_stderr',
			desktopStderrDetails(
				JSON.stringify({
					timestamp: 1,
					observedTimestamp: 1,
					severityText: severity,
					severityNumber,
					body: 'Invalid Namzu protocol response.',
					scope: {},
					resource: {},
					attributes: { content: 'PRIVATE_STDERR_ATTRIBUTE' },
				}),
			),
		)
	sink.record(
		'cli_stderr',
		desktopStderrDetails('Unstructured Node warning mentioning JSON; PRIVATE_WARNING'),
	)
	expect(records(sink).map((record) => record.severityText)).toEqual([
		'debug',
		'warn',
		'error',
		'warn',
	])
	expect(records(sink)[2].attributes['namzu.desktop.failure.reason']).toBe('protocol-invalid')
	expect(records(sink)[3].attributes['namzu.desktop.failure.reason']).not.toBe('protocol-invalid')
	expect(readFileSync(sink.path, 'utf8')).not.toContain('PRIVATE_')
})

it('captures a caught renderer console error without persisting its content or ordinary console output', () => {
	const { sink } = create()
	observeRendererConsole(sink, { level: 'info', message: 'PRIVATE_RENDERER_INFO', lineNumber: 1 })
	observeRendererConsole(sink, {
		level: 'error',
		message: 'The provider catalogue could not be loaded: PRIVATE_RENDERER_CONTENT',
		lineNumber: 17,
	})
	expect(records(sink)).toMatchObject([
		{
			eventName: 'namzu.desktop.renderer_failed',
			attributes: {
				'namzu.desktop.failure.reason': 'model-catalogue-unavailable',
				'namzu.desktop.line': 17,
			},
		},
	])
	expect(readFileSync(sink.path, 'utf8')).not.toContain('PRIVATE_')
})

it('rotates to one bounded previous file and limits a deterministic renderer flood', () => {
	let now = 0
	const { sink } = create(() => now)
	for (let index = 0; index < 3000; index++) {
		now += 10
		sink.record('cli_request_failed', {
			operation: 'namzu/pals/computer/start',
			request: index,
			error: 'A local Docker engine and image are required.',
		})
	}
	expect(statSync(sink.path).size).toBeLessThanOrEqual(512 * 1024)
	expect(statSync(sink.previousPath).size).toBeLessThanOrEqual(512 * 1024)
	const before = records(sink).length
	now = 100_000
	for (let index = 0; index < 1000; index++) sink.record('renderer_failed')
	expect(records(sink).length - before).toBe(201)
	expect(records(sink).at(-1).eventName).toBe('namzu.desktop.rate_limited')
	sink.record('ipc_failed', {
		operation: 'startPalComputer',
		error: 'The selected Podman machine is stopped or unavailable',
	})
	expect(records(sink).at(-1).attributes['namzu.desktop.failure.reason']).toBe(
		'podman-machine-stopped',
	)
	now += 1000
	sink.record('renderer_failed')
	expect(records(sink).at(-1).eventName).toBe('namzu.desktop.renderer_failed')
})

it('reports unavailable storage without throwing or changing the original operation failure', async () => {
	const { root } = create()
	const invalid = join(root, 'not-a-directory')
	writeFileSync(invalid, 'owned fixture')
	const sink = new DesktopDiagnostics(invalid)
	expect(sink.view()).toMatchObject({
		available: false,
		notice: expect.stringContaining('unavailable'),
	})
	expect(() => sink.record('startup_failed', { error: 'private' })).not.toThrow()
	const original = new Error('original')
	await expect(
		observeDesktopIpc(
			{
				record: () => {
					throw new Error('bad sink')
				},
			},
			'pals',
			() => {
				throw original
			},
			1,
		),
	).rejects.toBe(original)
})

it('refuses a redirected diagnostic file without touching its target', () => {
	const { root, sink } = create()
	const target = join(root, 'other-file')
	writeFileSync(target, 'untouched')
	rmSync(sink.path)
	symlinkSync(target, sink.path)
	sink.record('ipc_failed', { error: 'private' })
	expect(sink.view().available).toBe(false)
	expect(readFileSync(target, 'utf8')).toBe('untouched')
})

it('refuses a logs directory replaced after startup without appending to its redirected target', () => {
	const { root, sink } = create()
	const target = join(root, 'other-directory')
	mkdirSync(target)
	const redirected = join(target, 'desktop.ndjson')
	writeFileSync(redirected, 'untouched')
	renameSync(sink.directory, `${sink.directory}-old`)
	symlinkSync(target, sink.directory, 'junction')
	sink.record('ipc_failed', { error: 'private' })
	expect(sink.view().available).toBe(false)
	expect(readFileSync(redirected, 'utf8')).toBe('untouched')
})
