/**
 * Unit tests for `ensureDaemon`. We test every path that does NOT require
 * spawning a real subprocess (state-file read, health-poll over mocked
 * fetch, override pass-through, autoStart=false short-circuit). The actual
 * spawn → external `clawtool daemon start` path is exercised by the live
 * end-to-end smoke (see ses_002 progress entry "Live end-to-end smoke"),
 * not by this file — automating it cleanly requires a CI fixture that
 * we'll add when we wire integration tests in a later session.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClawtoolDaemonError, ensureDaemon } from './daemon.js'

function stateFileFixture(): { dir: string; tokenPath: string } {
	const home = mkdtempSync(join(tmpdir(), 'namzu-daemon-'))
	const configDir = join(home, '.config', 'clawtool')
	const tokenPath = join(configDir, 'listener-token')
	// Mirror what `clawtool daemon start` writes: state JSON + (sometimes) token.
	const state = {
		version: 1,
		pid: 99999,
		port: 51234,
		started_at: '2026-05-24T12:00:00Z',
		token_file: tokenPath,
		log_file: join(home, '.local', 'state', 'clawtool', 'daemon.log'),
	}
	const fs = require('node:fs') as typeof import('node:fs')
	fs.mkdirSync(configDir, { recursive: true })
	fs.writeFileSync(join(configDir, 'daemon.json'), JSON.stringify(state))
	return { dir: home, tokenPath }
}

describe('ensureDaemon', () => {
	let originalEnv: NodeJS.ProcessEnv

	beforeEach(() => {
		originalEnv = process.env
		process.env = { ...originalEnv }
	})

	afterEach(() => {
		process.env = originalEnv
	})

	it('returns immediately when endpoint AND token are both overridden — no daemon, no probe', async () => {
		const fetchMock = vi.fn<typeof fetch>()
		const result = await ensureDaemon({
			endpoint: 'http://daemon.example.com:9999',
			token: 'preset-token',
			fetch: fetchMock,
		})
		expect(result).toEqual({ baseUrl: 'http://daemon.example.com:9999', token: 'preset-token' })
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('uses state-file endpoint when daemon is healthy and no token file present (no-auth mode)', async () => {
		const { dir } = stateFileFixture()
		process.env = { ...originalEnv, XDG_CONFIG_HOME: join(dir, '.config') }
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }))
		const result = await ensureDaemon({ fetch: fetchMock })
		expect(result.baseUrl).toBe('http://127.0.0.1:51234')
		expect(result.token).toBe('') // no token file = no-auth daemon
		expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:51234/v1/health', { method: 'GET' })
	})

	it('uses state-file endpoint with token from file when present', async () => {
		const { dir, tokenPath } = stateFileFixture()
		writeFileSync(tokenPath, 'deadbeef\n')
		process.env = { ...originalEnv, XDG_CONFIG_HOME: join(dir, '.config') }
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }))
		const result = await ensureDaemon({ fetch: fetchMock })
		expect(result.token).toBe('deadbeef')
	})

	it('config.token wins over the file token', async () => {
		const { dir, tokenPath } = stateFileFixture()
		writeFileSync(tokenPath, 'file-token\n')
		process.env = { ...originalEnv, XDG_CONFIG_HOME: join(dir, '.config') }
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }))
		const result = await ensureDaemon({ fetch: fetchMock, token: 'override-token' })
		expect(result.token).toBe('override-token')
	})

	it('config.endpoint overrides the state-file port', async () => {
		const { dir } = stateFileFixture()
		process.env = { ...originalEnv, XDG_CONFIG_HOME: join(dir, '.config') }
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }))
		const result = await ensureDaemon({
			fetch: fetchMock,
			endpoint: 'http://my-remote-daemon:8765',
		})
		expect(result.baseUrl).toBe('http://my-remote-daemon:8765')
		expect(fetchMock).toHaveBeenCalledWith('http://my-remote-daemon:8765/v1/health', {
			method: 'GET',
		})
	})

	it('throws ClawtoolDaemonError when autoStart=false and the daemon is unreachable', async () => {
		// Point to an XDG dir with no state file → readDaemonState returns null
		// → tryStateEndpoint returns null → autoStart short-circuits.
		const empty = mkdtempSync(join(tmpdir(), 'namzu-daemon-empty-'))
		process.env = { ...originalEnv, XDG_CONFIG_HOME: empty }
		await expect(ensureDaemon({ autoStart: false, fetch: vi.fn<typeof fetch>() })).rejects.toThrow(
			ClawtoolDaemonError,
		)
	})

	it('treats non-200 /v1/health as unhealthy and (with autoStart=false) gives up', async () => {
		const { dir } = stateFileFixture()
		process.env = { ...originalEnv, XDG_CONFIG_HOME: join(dir, '.config') }
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }))
		await expect(ensureDaemon({ autoStart: false, fetch: fetchMock })).rejects.toThrow(
			ClawtoolDaemonError,
		)
	})

	it('treats fetch error as unhealthy and (with autoStart=false) gives up', async () => {
		const { dir } = stateFileFixture()
		process.env = { ...originalEnv, XDG_CONFIG_HOME: join(dir, '.config') }
		const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'))
		await expect(ensureDaemon({ autoStart: false, fetch: fetchMock })).rejects.toThrow(
			ClawtoolDaemonError,
		)
	})
})
