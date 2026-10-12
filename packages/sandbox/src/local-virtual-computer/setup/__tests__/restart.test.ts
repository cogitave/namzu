import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WslcRestartMarker, WslcSetupHost } from '../contract.js'
import { createWslcSetupHost, parseRegDword } from '../host.js'
import { clearRestartMarker, readRestartMarker, writeRestartMarker } from '../restart.js'
import { failure, fakeRunner, tempDirectory } from './fakes.js'

let directory: string
let host: WslcSetupHost
beforeEach(async () => {
	directory = await tempDirectory()
	host = createWslcSetupHost({ stateDirectory: join(directory, 'nested', 'setup') })
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

const MARKER: WslcRestartMarker = {
	recordedAt: '2026-10-12T09:00:00.000Z',
	planId: 'abc',
	remaining: ['load-image'],
}

describe('restart marker', () => {
	it('round-trips and creates the directory', async () => {
		expect(await readRestartMarker(host)).toBeUndefined()
		await writeRestartMarker(host, MARKER)
		expect(await readRestartMarker(host)).toEqual(MARKER)
	})

	it('replaces an earlier marker and leaves no temp file behind', async () => {
		await writeRestartMarker(host, MARKER)
		await writeRestartMarker(host, { ...MARKER, planId: 'second', remaining: [] })
		expect((await readRestartMarker(host))?.planId).toBe('second')
		expect(await readdir(host.stateDirectory)).toEqual(['restart.json'])
	})

	it('never exposes half a marker: the file is complete JSON the moment it exists', async () => {
		await writeRestartMarker(host, MARKER)
		const text = await readFile(join(host.stateDirectory, 'restart.json'), 'utf8')
		expect(JSON.parse(text)).toEqual(MARKER)
	})

	it('clears, and clearing nothing is fine', async () => {
		await clearRestartMarker(host)
		await writeRestartMarker(host, MARKER)
		await clearRestartMarker(host)
		expect(await readRestartMarker(host)).toBeUndefined()
	})

	it.each([
		['not JSON', '{nope'],
		['not an object', '[]'],
		['a bad time', JSON.stringify({ ...MARKER, recordedAt: 'later' })],
		['an unknown step', JSON.stringify({ ...MARKER, remaining: ['format-disk'] })],
		['a missing plan', JSON.stringify({ recordedAt: MARKER.recordedAt, remaining: [] })],
	])('reads %s as no marker', async (_label, text) => {
		await mkdir(host.stateDirectory, { recursive: true })
		await writeFile(join(host.stateDirectory, 'restart.json'), text)
		expect(await readRestartMarker(host)).toBeUndefined()
	})
})

describe('the real host', () => {
	it('parses a DWORD from reg.exe output and nothing else', () => {
		expect(
			parseRegDword(
				'\r\nHKEY_LOCAL_MACHINE\\Software\\Policies\\WSL\r\n    AllowWSL    REG_DWORD    0x0\r\n',
			),
		).toBe(0)
		expect(parseRegDword('    X    REG_DWORD    0x1f\r\n')).toBe(31)
		expect(parseRegDword('    X    REG_SZ    0x1f\r\n')).toBeUndefined()
		expect(parseRegDword('')).toBeUndefined()
	})

	it('reads a value through reg.exe and treats an absent key as not set', async () => {
		const runner = fakeRunner({
			'reg query HKLM\\Software\\Policies\\WSL /v AllowWSL': '    AllowWSL    REG_DWORD    0x0\r\n',
			'reg query HKLM\\Software\\Policies\\WSL /v AllowWSLContainer': failure(1),
		})
		const real = createWslcSetupHost({ runner })
		expect(await real.readDword('HKLM\\Software\\Policies\\WSL', 'AllowWSL')).toBe(0)
		expect(
			await real.readDword('HKLM\\Software\\Policies\\WSL', 'AllowWSLContainer'),
		).toBeUndefined()
	})

	it('reads the boot time from one PowerShell answer', async () => {
		const runner = fakeRunner({
			"powershell -NoProfile -NonInteractive -Command (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')":
				'2026-10-12T05:30:00.0000000Z\r\n',
		})
		const real = createWslcSetupHost({ runner })
		expect((await real.bootTime()).toISOString()).toBe('2026-10-12T05:30:00.000Z')
	})

	it('puts its state under LOCALAPPDATA on Windows and honours overrides', () => {
		const real = createWslcSetupHost({
			platform: 'win32',
			env: { LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' },
		})
		expect(real.stateDirectory).toBe('C:\\Users\\Ada\\AppData\\Local\\Namzu\\setup')
		expect(real.resumeRegistryKey).toBe(
			'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
		)
		expect(createWslcSetupHost({ stateDirectory: 'X', resumeRegistryKey: 'K' })).toMatchObject({
			stateDirectory: 'X',
			resumeRegistryKey: 'K',
		})
	})
})
