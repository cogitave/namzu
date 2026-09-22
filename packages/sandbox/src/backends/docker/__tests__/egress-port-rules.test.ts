import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseProxyConfigV2 } from '../../../../egress-proxy/server.mjs'
import { defineEgressProfile } from '../../../egress/profile.js'
import { REMOTE_EXECUTION_PROTOCOL_VERSION } from '../../remote-execution-controller.js'
import {
	type DockerBackendInternalConfig,
	EGRESS_PROXY_CONFIG_V2_ENV,
	buildDockerBackend,
	egressProxyContainerConfig,
	renderEgressProxyRunArgs,
	resolveLayout,
} from '../index.js'

/**
 * Port rules on the docker backend: the proxy configuration travels as V2
 * (`NAMZU_EGRESS_PROXY_CONFIG_V2`) only when the egress profile carries ports,
 * and only after the proxy image's `ai.namzu.egress-proxy.config` label says
 * it can read them. Every other policy is V1 exactly as before, which the
 * existing `egress-topology.test.ts` pins unchanged.
 */

const layout = resolveLayout({ outputs: { source: { type: 'hostDir', hostPath: '/h/out' } } })
const withPorts = defineEgressProfile({
	name: 'api',
	hosts: [{ host: 'api.example.com', ports: [443] }, { host: '.example.org' }],
})
const withoutPorts = defineEgressProfile({ name: 'plain', hosts: [{ host: 'api.example.com' }] })

describe('the V2 configuration, as values', () => {
	it('names the V2 variable in the argv only when the profile has ports', () => {
		const input = (egressProfile?: typeof withPorts) => ({
			config: {
				image: 'i',
				egressProxyImage: 'p',
				layout,
				...(egressProfile ? { egressProfile } : {}),
			} as DockerBackendInternalConfig,
			containerName: 'namzu-egress-x',
			upstreamNetwork: 'bridge',
			internalNetwork: 'namzu-tasks',
		})
		const v2 = renderEgressProxyRunArgs(input(withPorts))
		expect(v2).toContain(EGRESS_PROXY_CONFIG_V2_ENV)
		expect(v2).not.toContain('NAMZU_EGRESS_PROXY_CONFIG')

		for (const argv of [
			renderEgressProxyRunArgs(input(withoutPorts)),
			renderEgressProxyRunArgs(input()),
		]) {
			expect(argv).toContain('NAMZU_EGRESS_PROXY_CONFIG')
			expect(argv).not.toContain(EGRESS_PROXY_CONFIG_V2_ENV)
		}
	})

	it('carries every profile rule, and the container parser accepts it', () => {
		const config = egressProxyContainerConfig(
			{ egressProfile: withPorts },
			['api.example.com'],
			2025,
		)
		expect(config.hostPorts).toEqual([
			{ host: 'api.example.com', ports: [443] },
			{ host: '.example.org' },
		])
		const parsed = parseProxyConfigV2(JSON.stringify(config))
		expect(parsed.hostPorts).toEqual(config.hostPorts)
		expect(parsed.allowedHosts).toEqual(['api.example.com'])
	})

	it('adds no hostPorts key without port rules', () => {
		expect(
			Object.keys(egressProxyContainerConfig({ egressProfile: withoutPorts }, [], 2025)),
		).not.toContain('hostPorts')
	})
})

describe('the proxy image label, checked before anything starts', () => {
	const realFetch = globalThis.fetch
	let workDir: string
	let dockerShim: string
	let dockerLog: string
	let envLog: string

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), 'namzu-docker-port-rules-'))
		dockerShim = join(workDir, 'docker-shim')
		dockerLog = join(workDir, 'docker.log')
		envLog = join(workDir, 'env.log')
		writeFileSync(dockerLog, '')
		writeFileSync(envLog, '')
		process.env.NAMZU_P_LOG = dockerLog
		process.env.NAMZU_P_ENV_LOG = envLog
		process.env.NAMZU_P_LABEL = '2'
		writeFileSync(
			dockerShim,
			[
				'#!/bin/sh',
				'for a in "$@"; do printf "%s\\037" "$a"; done >> "${NAMZU_P_LOG:?}"',
				'printf "\\n" >> "${NAMZU_P_LOG:?}"',
				'printf "V1=%s|V2=%s\\n" "${NAMZU_EGRESS_PROXY_CONFIG:-}" "${NAMZU_EGRESS_PROXY_CONFIG_V2:-}" >> "${NAMZU_P_ENV_LOG:?}"',
				'case "$1" in',
				'  image) if [ "${NAMZU_P_LABEL:-}" = "missing" ]; then echo "No such image" >&2; exit 1; fi; printf "%s\\n" "${NAMZU_P_LABEL:-}" ;;',
				'  network) if [ "$2" = "inspect" ]; then printf "true\\n"; fi ;;',
				'  run) printf "container-id\\n" ;;',
				'  inspect) printf "true\\n" ;;',
				'  rm) ;;',
				'  *) exit 2 ;;',
				'esac',
			].join('\n'),
			{ mode: 0o755 },
		)
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ ok: true, protocolVersion: REMOTE_EXECUTION_PROTOCOL_VERSION }),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		) as typeof fetch
	})

	afterEach(() => {
		vi.restoreAllMocks()
		globalThis.fetch = realFetch
		process.env.NAMZU_P_LOG = undefined
		process.env.NAMZU_P_ENV_LOG = undefined
		process.env.NAMZU_P_LABEL = undefined
		rmSync(workDir, { recursive: true, force: true })
	})

	function backend(egressProfile: typeof withPorts) {
		return buildDockerBackend({
			image: 'namzu-sandbox:latest',
			egressProxyImage: 'namzu-egress-proxy:latest',
			layout,
			network: 'namzu-tasks',
			hostReachability: 'container-network',
			dockerBinary: dockerShim,
			readyTimeoutMs: 200,
			readyPollIntervalMs: 5,
			egressProfile,
		})
	}

	function calls(): string[][] {
		return readFileSync(dockerLog, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => line.split('\u001f').slice(0, -1))
	}

	const egress = { kind: 'static', allowedHosts: ['api.example.com', '.example.org'] } as const

	it('sends V2 alone, after reading the label', async () => {
		const sandbox = await backend(withPorts).create({ workingDirectory: workDir, egress })
		try {
			const all = calls()
			const imageIndex = all.findIndex((argv) => argv[0] === 'image')
			const runIndex = all.findIndex((argv) => argv[0] === 'run')
			expect(all[imageIndex]).toEqual([
				'image',
				'inspect',
				'--format',
				'{{ index .Config.Labels "ai.namzu.egress-proxy.config" }}',
				'namzu-egress-proxy:latest',
			])
			expect(imageIndex).toBeLessThan(runIndex)
			const proxyLaunchEnv = readFileSync(envLog, 'utf8').split('\n')[runIndex] as string
			expect(proxyLaunchEnv.startsWith('V1=|V2={')).toBe(true)
			const v2 = JSON.parse(proxyLaunchEnv.slice('V1=|V2='.length)) as { hostPorts: unknown }
			expect(v2.hostPorts).toEqual([
				{ host: 'api.example.com', ports: [443] },
				{ host: '.example.org' },
			])
		} finally {
			await sandbox.destroy()
		}
	})

	it.each([
		['', 'an image with no label'],
		['1', 'an image that reads V1 only'],
		['missing', 'an image the daemon does not have'],
	])('refuses %j (%s) before any container starts', async (label) => {
		process.env.NAMZU_P_LABEL = label
		await expect(backend(withPorts).create({ workingDirectory: workDir, egress })).rejects.toThrow(
			/does not declare that it reads port rules/,
		)
		expect(calls().filter((argv) => argv[0] === 'run')).toEqual([])
	})

	it('reads no label and sends V1 when the profile has no ports', async () => {
		process.env.NAMZU_P_LABEL = ''
		const sandbox = await backend(withoutPorts).create({
			workingDirectory: workDir,
			egress: { kind: 'static', allowedHosts: ['api.example.com'] },
		})
		try {
			expect(calls().filter((argv) => argv[0] === 'image')).toEqual([])
			const runIndex = calls().findIndex((argv) => argv[0] === 'run')
			expect(readFileSync(envLog, 'utf8').split('\n')[runIndex]).toMatch(/^V1=\{.*\|V2=$/)
		} finally {
			await sandbox.destroy()
		}
	})
})
