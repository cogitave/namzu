/**
 * Behavioural contract for `createSandboxProvider`, `resolveLayout`,
 * and `renderLayoutMountArgs`:
 *
 * - Builds a `SandboxProvider` for the `container:docker` tier
 *   without spawning anything (the container only spawns on
 *   `provider.create()`, not at construction time). The provider
 *   carries a layout baked in at construction; per-task hosts
 *   construct one provider per task.
 * - Throws `SandboxBackendNotImplementedError` for tiers the docker
 *   backend has not landed yet, with a label that names the missing
 *   tier and concrete service.
 * - Layout validation happens synchronously inside
 *   `createSandboxProvider`; `ContainerSandboxLayoutValidationError` exposes
 *   a `reasons` array so consumers see every violation in one
 *   round-trip.
 * - Every `--volume` source rendered by the docker backend traces
 *   back to a layout `hostDir.hostPath` declared by the consumer —
 *   pinned here as a regression guard against the old `mkdtemp`-
 *   allocated workspace path that hit EACCES in sibling-container
 *   deployments.
 *
 * Docker-touching integration tests live under
 * `backends/docker/__tests__/` and skip when `docker` isn't
 * available; this file stays pure-unit.
 */

import { describe, expect, it } from 'vitest'

import type { ContainerSandboxLayout } from '@namzu/sdk'

import { renderLayoutMountArgs, resolveLayout } from './backends/docker/index.js'
import {
	ContainerSandboxLayoutValidationError,
	SandboxBackendNotImplementedError,
	type SerializedSandboxError,
	createSandboxProvider,
	serializeSandboxError,
} from './index.js'

// Convenience: a complete, valid layout the tests reuse and mutate.
function validLayout(overrides: Partial<ContainerSandboxLayout> = {}): ContainerSandboxLayout {
	return {
		outputs: { source: { type: 'hostDir', hostPath: '/host/out' } },
		...overrides,
	}
}

const DOCKER_BACKEND = {
	tier: 'container',
	runtime: 'docker',
	image: 'namzu-worker:latest',
} as const

describe('createSandboxProvider', () => {
	it('builds a provider for container:docker without spawning anything', () => {
		const provider = createSandboxProvider({
			backend: DOCKER_BACKEND,
			layout: validLayout(),
		})

		expect(provider.id).toContain('container')
		expect(provider.id).toContain('docker')
		expect(provider.name).toContain('container:docker')
	})

	it('treats container with no runtime as docker (default)', () => {
		const provider = createSandboxProvider({
			backend: { tier: 'container', image: 'namzu-worker:latest' },
			layout: validLayout(),
		})

		expect(provider.id).toContain('docker')
	})

	it('throws SandboxBackendNotImplementedError for microvm:e2b until P3.3 lands', () => {
		expect(() =>
			createSandboxProvider({
				backend: { tier: 'microvm', service: 'e2b', apiKey: 'test' },
			}),
		).toThrow(SandboxBackendNotImplementedError)

		try {
			createSandboxProvider({
				backend: { tier: 'microvm', service: 'fly-machines', apiToken: 't', app: 'a', image: 'i' },
			})
		} catch (err) {
			expect(err).toBeInstanceOf(SandboxBackendNotImplementedError)
			expect((err as SandboxBackendNotImplementedError).backend).toBe('microvm:fly-machines')
		}
	})

	it('throws for process tier until P3.4 lands, naming the engine in the label', () => {
		try {
			createSandboxProvider({ backend: { tier: 'process', engine: 'bubblewrap' } })
		} catch (err) {
			expect(err).toBeInstanceOf(SandboxBackendNotImplementedError)
			expect((err as SandboxBackendNotImplementedError).backend).toBe('process:bubblewrap')
		}
	})

	it('throws for container:runsc until P3.5 lands', () => {
		try {
			createSandboxProvider({
				backend: { tier: 'container', runtime: 'runsc', image: 'i' },
				layout: validLayout(),
			})
		} catch (err) {
			expect(err).toBeInstanceOf(SandboxBackendNotImplementedError)
			expect((err as SandboxBackendNotImplementedError).backend).toBe('container:runsc')
		}
	})

	it('throws for passthrough tier until it lands', () => {
		try {
			createSandboxProvider({ backend: { tier: 'passthrough' } })
		} catch (err) {
			expect(err).toBeInstanceOf(SandboxBackendNotImplementedError)
			expect((err as SandboxBackendNotImplementedError).backend).toBe('passthrough')
		}
	})

	it('rejects construction when the layout fails validation — surfaces during host wiring', () => {
		const bad = {} as ContainerSandboxLayout
		expect(() =>
			createSandboxProvider({
				backend: DOCKER_BACKEND,
				layout: bad,
			}),
		).toThrow(ContainerSandboxLayoutValidationError)
	})
})

describe('resolveLayout', () => {
	it('applies Anthropic-style default container paths to declared mounts', () => {
		const resolved = resolveLayout({
			outputs: { source: { type: 'hostDir', hostPath: '/host/out' } },
			uploads: { source: { type: 'hostDir', hostPath: '/host/up' } },
			toolResults: { source: { type: 'hostDir', hostPath: '/host/tr' } },
			transcripts: { source: { type: 'hostDir', hostPath: '/host/ts' } },
			skills: [
				{ id: 'pdf-tools', source: { type: 'hostDir', hostPath: '/host/skills/pdf-tools' } },
				{ id: 'data-viz', source: { type: 'hostDir', hostPath: '/host/skills/data-viz' } },
			],
		})

		expect(resolved.outputs.containerPath).toBe('/mnt/user-data/outputs')
		expect(resolved.uploads?.containerPath).toBe('/mnt/user-data/uploads')
		expect(resolved.toolResults?.containerPath).toBe('/mnt/user-data/tool_results')
		expect(resolved.transcripts?.containerPath).toBe('/mnt/transcripts')
		expect(resolved.skills?.map((s) => s.containerPath)).toEqual([
			'/mnt/skills/pdf-tools',
			'/mnt/skills/data-viz',
		])
	})

	it('honours explicit container path overrides', () => {
		const resolved = resolveLayout({
			outputs: {
				source: { type: 'hostDir', hostPath: '/h/o' },
				containerPath: '/work/out',
			},
			uploads: {
				source: { type: 'hostDir', hostPath: '/h/u' },
				containerPath: '/work/up',
			},
			skills: [
				{
					id: 'k',
					source: { type: 'hostDir', hostPath: '/h/s' },
					containerPath: '/opt/skills/custom',
				},
			],
		})
		expect(resolved.outputs.containerPath).toBe('/work/out')
		expect(resolved.uploads?.containerPath).toBe('/work/up')
		expect(resolved.skills?.[0]?.containerPath).toBe('/opt/skills/custom')
	})

	it('omits fields the host did not declare', () => {
		const resolved = resolveLayout(validLayout())
		expect(resolved.outputs).toBeDefined()
		expect(resolved.uploads).toBeUndefined()
		expect(resolved.toolResults).toBeUndefined()
		expect(resolved.transcripts).toBeUndefined()
		expect(resolved.skills).toBeUndefined()
	})

	it('drops an empty skills array (treated as no skills)', () => {
		const resolved = resolveLayout(validLayout({ skills: [] }))
		expect(resolved.skills).toBeUndefined()
	})

	it('does not expose a scratchpad field — image-bake responsibility, not a public knob', () => {
		const resolved = resolveLayout(validLayout())
		expect((resolved as unknown as Record<string, unknown>).scratchpad).toBeUndefined()
	})

	it('rejects a layout with no outputs (deliverables surface required)', () => {
		const bad = {} as ContainerSandboxLayout
		expect(() => resolveLayout(bad)).toThrow(ContainerSandboxLayoutValidationError)
		try {
			resolveLayout(bad)
		} catch (err) {
			expect(err).toBeInstanceOf(ContainerSandboxLayoutValidationError)
			const reasons = (err as ContainerSandboxLayoutValidationError).reasons
			expect(reasons.some((r) => r.includes('outputs'))).toBe(true)
		}
	})

	it('rejects malformed skill ids (whitespace, slashes)', () => {
		const layout: ContainerSandboxLayout = {
			...validLayout(),
			skills: [
				{ id: 'has space', source: { type: 'hostDir', hostPath: '/a' } },
				{ id: 'has/slash', source: { type: 'hostDir', hostPath: '/b' } },
				{ id: 'good_one.v2', source: { type: 'hostDir', hostPath: '/c' } },
			],
		}
		try {
			resolveLayout(layout)
			throw new Error('expected ContainerSandboxLayoutValidationError')
		} catch (err) {
			expect(err).toBeInstanceOf(ContainerSandboxLayoutValidationError)
			const reasons = (err as ContainerSandboxLayoutValidationError).reasons
			expect(reasons.length).toBe(2)
			expect(reasons.join('\n')).toContain('"has space"')
			expect(reasons.join('\n')).toContain('"has/slash"')
		}
	})

	it('rejects every form of `..` in skill ids — not just the bare segment', () => {
		const layout: ContainerSandboxLayout = {
			...validLayout(),
			skills: [
				{ id: '..', source: { type: 'hostDir', hostPath: '/a' } },
				{ id: 'foo..bar', source: { type: 'hostDir', hostPath: '/b' } },
				{ id: '..foo', source: { type: 'hostDir', hostPath: '/c' } },
				{ id: 'foo..', source: { type: 'hostDir', hostPath: '/d' } },
			],
		}
		try {
			resolveLayout(layout)
			throw new Error('expected ContainerSandboxLayoutValidationError')
		} catch (err) {
			expect(err).toBeInstanceOf(ContainerSandboxLayoutValidationError)
			const reasons = (err as ContainerSandboxLayoutValidationError).reasons
			expect(reasons.length).toBe(4)
			for (const id of ['..', 'foo..bar', '..foo', 'foo..']) {
				expect(reasons.join('\n')).toContain(JSON.stringify(id))
			}
		}
	})

	it('accepts isolated dots in skill ids (versioned skills like pdf-tools.v2)', () => {
		const resolved = resolveLayout({
			...validLayout(),
			skills: [
				{ id: 'pdf-tools.v2', source: { type: 'hostDir', hostPath: '/a' } },
				{ id: 'data.viz.legacy', source: { type: 'hostDir', hostPath: '/b' } },
			],
		})
		expect(resolved.skills?.map((s) => s.id)).toEqual(['pdf-tools.v2', 'data.viz.legacy'])
	})

	it('rejects duplicate skill ids', () => {
		const layout: ContainerSandboxLayout = {
			...validLayout(),
			skills: [
				{ id: 'pdf-tools', source: { type: 'hostDir', hostPath: '/a' } },
				{ id: 'pdf-tools', source: { type: 'hostDir', hostPath: '/b' } },
			],
		}
		try {
			resolveLayout(layout)
			throw new Error('expected ContainerSandboxLayoutValidationError')
		} catch (err) {
			expect(err).toBeInstanceOf(ContainerSandboxLayoutValidationError)
			expect((err as ContainerSandboxLayoutValidationError).reasons.join('\n')).toContain(
				'duplicate skill id "pdf-tools"',
			)
		}
	})

	it('rejects duplicate containerPaths across mounts', () => {
		const layout: ContainerSandboxLayout = {
			outputs: {
				source: { type: 'hostDir', hostPath: '/a' },
				containerPath: '/work',
			},
			uploads: {
				source: { type: 'hostDir', hostPath: '/b' },
				containerPath: '/work',
			},
		}
		try {
			resolveLayout(layout)
			throw new Error('expected ContainerSandboxLayoutValidationError')
		} catch (err) {
			expect(err).toBeInstanceOf(ContainerSandboxLayoutValidationError)
			const reasons = (err as ContainerSandboxLayoutValidationError).reasons
			expect(reasons.some((r) => r.includes('"/work"'))).toBe(true)
		}
	})

	it('rejects duplicate containerPaths between a skill and a top-level mount', () => {
		const layout: ContainerSandboxLayout = {
			outputs: {
				source: { type: 'hostDir', hostPath: '/a' },
				containerPath: '/mnt/skills/x',
			},
			skills: [
				{
					id: 'x',
					source: { type: 'hostDir', hostPath: '/b' },
					// default `/mnt/skills/x` collides with outputs above
				},
			],
		}
		expect(() => resolveLayout(layout)).toThrow(ContainerSandboxLayoutValidationError)
	})

	it('collects every violation in one pass — fix-then-rerun loops are wasted', () => {
		const bad = {
			// missing outputs
			skills: [
				{ id: 'has space', source: { type: 'hostDir', hostPath: '/a' } },
				{ id: 'has space', source: { type: 'hostDir', hostPath: '/b' } },
			],
		} as unknown as ContainerSandboxLayout
		try {
			resolveLayout(bad)
			throw new Error('expected ContainerSandboxLayoutValidationError')
		} catch (err) {
			expect(err).toBeInstanceOf(ContainerSandboxLayoutValidationError)
			const reasons = (err as ContainerSandboxLayoutValidationError).reasons
			// Three distinct violations: missing outputs, malformed id, duplicate id.
			expect(reasons.length).toBeGreaterThanOrEqual(3)
		}
	})
})

describe('ContainerSandboxLayoutValidationError', () => {
	it('serialises through JSON.stringify with reasons preserved', () => {
		const err = new ContainerSandboxLayoutValidationError([
			'`outputs` is required (deliverables surface).',
			'duplicate skill id "pdf-tools"',
		])
		const json = JSON.parse(JSON.stringify(err))
		expect(json.name).toBe('ContainerSandboxLayoutValidationError')
		expect(json.reasons).toEqual([
			'`outputs` is required (deliverables surface).',
			'duplicate skill id "pdf-tools"',
		])
		expect(json.message).toContain('Invalid ContainerSandboxLayout:')
	})

	it('keeps `reasons` as a stable property after construction', () => {
		const err = new ContainerSandboxLayoutValidationError(['reason a', 'reason b'])
		expect(err.reasons).toEqual(['reason a', 'reason b'])
		expect(err.name).toBe('ContainerSandboxLayoutValidationError')
		expect(err.message).toBe('Invalid ContainerSandboxLayout: reason a; reason b')
	})

	it('accepts a `cause` and exposes it on `toJSON()`', () => {
		const root = new Error('underlying cause')
		const err = new ContainerSandboxLayoutValidationError(['x'], { cause: root })
		expect(err.cause).toBe(root)
		const json = err.toJSON()
		expect(json.cause).toBe(root)
	})
})

describe('serializeSandboxError — transport-safe error envelope', () => {
	it('serialises a ContainerSandboxLayoutValidationError with reasons preserved', () => {
		const err = new ContainerSandboxLayoutValidationError(['a', 'b'])
		const out = serializeSandboxError(err)
		expect(out.name).toBe('ContainerSandboxLayoutValidationError')
		expect(out.reasons).toEqual(['a', 'b'])
		expect(out.message).toContain('Invalid ContainerSandboxLayout: a; b')
		expect(typeof out.stack === 'string' || typeof out.stack === 'undefined').toBe(true)
	})

	it('survives JSON.stringify → JSON.parse round-trip with reasons intact', () => {
		const err = new ContainerSandboxLayoutValidationError(['a', 'b'])
		const wire = JSON.parse(JSON.stringify(serializeSandboxError(err)))
		expect(wire.name).toBe('ContainerSandboxLayoutValidationError')
		expect(wire.reasons).toEqual(['a', 'b'])
	})

	it('survives structuredClone with reasons intact', () => {
		const err = new ContainerSandboxLayoutValidationError(['a', 'b'])
		const cloned = structuredClone(serializeSandboxError(err))
		expect(cloned.name).toBe('ContainerSandboxLayoutValidationError')
		expect(cloned.reasons).toEqual(['a', 'b'])
	})

	it('preserves the cause chain — nested validation error in an outer Error', () => {
		const inner = new ContainerSandboxLayoutValidationError(['inner reason'])
		const outer = new Error('outer message', { cause: inner })
		const out = serializeSandboxError(outer)
		expect(out.name).toBe('Error')
		expect(out.message).toBe('outer message')
		// `cause` should itself be a serialised envelope, not the raw Error.
		const cause = out.cause as { name: string; reasons?: readonly string[] }
		expect(cause.name).toBe('ContainerSandboxLayoutValidationError')
		expect(cause.reasons).toEqual(['inner reason'])
	})

	it('wraps a plain-object cause in a NonError envelope (no verbatim leak)', () => {
		const outer = new Error('outer', { cause: { kind: 'opaque', code: 42 } })
		const out = serializeSandboxError(outer)
		const cause = out.cause
		expect(cause).toBeDefined()
		expect(cause?.name).toBe('NonError')
		// The receiver gets a string envelope rather than the raw object;
		// every leaf is JSON-safe + structuredClone-safe.
		expect(typeof cause?.message).toBe('string')
		expect(cause?.message).toContain('opaque')
	})

	it('wraps non-Error inputs in a NonError envelope', () => {
		expect(serializeSandboxError('plain string').name).toBe('NonError')
		expect(serializeSandboxError('plain string').message).toBe('plain string')
		expect(serializeSandboxError({ x: 1 }).name).toBe('NonError')
		expect(serializeSandboxError(null).name).toBe('NonError')
		expect(serializeSandboxError(null).message).toBe('null')
		expect(serializeSandboxError(undefined).name).toBe('NonError')
		expect(serializeSandboxError(undefined).message).toBe('undefined')
		expect(serializeSandboxError(42).name).toBe('NonError')
		expect(serializeSandboxError(42).message).toBe('42')
		expect(serializeSandboxError(true).name).toBe('NonError')
		expect(serializeSandboxError(true).message).toBe('true')
	})

	// Codex round 5 (C): the envelope must defend against values that
	// JSON.stringify either drops silently or that structuredClone
	// throws on. Each of these cases asserts a specific envelope shape
	// AND that the result survives both transport channels.
	it('encodes Function causes as { name: "Function", message: "[function]" }', () => {
		const outer = new Error('outer', { cause: () => undefined })
		const out = serializeSandboxError(outer)
		expect(out.cause).toEqual({ name: 'Function', message: '[function]' })
		// Both transports succeed.
		expect(() => JSON.stringify(out)).not.toThrow()
		expect(() => structuredClone(out)).not.toThrow()
	})

	it('encodes Symbol causes with the description preserved', () => {
		const outer = new Error('outer', { cause: Symbol('x') })
		const out = serializeSandboxError(outer)
		expect(out.cause?.name).toBe('Symbol')
		expect(out.cause?.message).toBe('Symbol(x)')
		expect(() => JSON.stringify(out)).not.toThrow()
		expect(() => structuredClone(out)).not.toThrow()
	})

	it('encodes BigInt causes via .toString()', () => {
		const outer = new Error('outer', { cause: 42n })
		const out = serializeSandboxError(outer)
		expect(out.cause).toEqual({ name: 'BigInt', message: '42' })
		expect(() => JSON.stringify(out)).not.toThrow()
		expect(() => structuredClone(out)).not.toThrow()
	})

	it('encodes NaN / ±Infinity as NonFiniteNumber instead of letting JSON drop them', () => {
		for (const [v, msg] of [
			[Number.NaN, 'NaN'],
			[Number.POSITIVE_INFINITY, 'Infinity'],
			[Number.NEGATIVE_INFINITY, '-Infinity'],
		] as const) {
			const outer = new Error('outer', { cause: v })
			const out = serializeSandboxError(outer)
			expect(out.cause).toEqual({ name: 'NonFiniteNumber', message: msg })
			// JSON.stringify silently turns NaN/Infinity into `null` if
			// they leak in raw; the envelope keeps them as a string
			// message so the receiver sees the truth.
			const wire = JSON.parse(JSON.stringify(out))
			expect(wire.cause.message).toBe(msg)
		}
	})

	// Codex round 5 (B): cycle guard. The previous round-4 implementation
	// recursed unconditionally on `cause`, so a cycle would either
	// stack-overflow (synchronous) or trip JSON.stringify's circular
	// detection (async via the receiver). The WeakSet path replaces
	// the offending node with a sentinel envelope.
	it('breaks self-cycles without stack overflow', () => {
		const a = new Error('self-loop')
		// Direct self-reference: cause === a.
		;(a as Error & { cause?: unknown }).cause = a
		const out = serializeSandboxError(a)
		expect(out.name).toBe('Error')
		expect(out.message).toBe('self-loop')
		expect(out.cause?.name).toBe('CircularReference')
		expect(out.cause?.message).toBe('[circular]')
		expect(() => JSON.stringify(out)).not.toThrow()
	})

	it('breaks two-node cycles (a.cause = b; b.cause = a)', () => {
		const a = new Error('a')
		const b = new Error('b')
		;(a as Error & { cause?: unknown }).cause = b
		;(b as Error & { cause?: unknown }).cause = a
		const out = serializeSandboxError(a)
		expect(out.name).toBe('Error')
		expect(out.message).toBe('a')
		// First step: a → b; b's cause loops back to the already-seen a,
		// so the deepest serialised cause is the CircularReference sentinel.
		const aCause = out.cause
		expect(aCause?.name).toBe('Error')
		expect(aCause?.message).toBe('b')
		expect(aCause?.cause?.name).toBe('CircularReference')
		expect(() => JSON.stringify(out)).not.toThrow()
	})

	it('walks long causal chains without depth-cap truncation', () => {
		// Build a 20-deep chain. The WeakSet-based guard does not
		// truncate by depth; only cycles trigger the sentinel.
		const chain: Error[] = []
		for (let i = 0; i < 20; i++) {
			const e = new Error(`step-${i}`)
			if (i > 0) {
				;(e as Error & { cause?: unknown }).cause = chain[i - 1]
			}
			chain.push(e)
		}
		const top = chain[chain.length - 1] as Error
		const out = serializeSandboxError(top)
		// Walk the cause chain and count the depth.
		let cursor: SerializedSandboxError | undefined = out
		let depth = 0
		while (cursor) {
			depth++
			cursor = cursor.cause
		}
		expect(depth).toBe(20)
		// No CircularReference sentinel should appear in a non-cyclic chain.
		const wire = JSON.stringify(out)
		expect(wire).not.toContain('CircularReference')
	})

	it('detects a cycle via plain-object cause (a.cause = a where a is a plain object)', () => {
		// The cycle guard also runs for plain-object inputs, not just
		// Error instances, because a non-Error cause can still close a
		// loop with itself.
		const obj: { kind: string; cause?: unknown } = { kind: 'self' }
		obj.cause = obj
		const out = serializeSandboxError(obj)
		// Plain-object input → NonError envelope. The cycle-guard
		// path prevents safeStringify from getting a recursive object
		// in the first place, but the contract for non-Error inputs
		// stays a single NonError envelope (no nested cause walk for
		// non-Error values today).
		expect(out.name).toBe('NonError')
	})
})

describe('public exports — runtime import paths', () => {
	// Codex round 4 (E): Vandal-side prompt template generators must
	// be able to import the default-path constants from the sandbox
	// package via the SDK's root barrel. `@namzu/sdk` exposes only
	// `"."` in its package.json `exports`; subpath imports like
	// `@namzu/sdk/constants/sandbox` would fail at runtime. This
	// test exercises the actual import paths the host will use, so a
	// future package.json change that breaks the root re-export
	// surfaces here.
	it('@namzu/sandbox re-exports the SANDBOX_DEFAULT_*_PATH constants', async () => {
		const mod = await import('./index.js')
		expect(mod.SANDBOX_DEFAULT_OUTPUTS_PATH).toBe('/mnt/user-data/outputs')
		expect(mod.SANDBOX_DEFAULT_UPLOADS_PATH).toBe('/mnt/user-data/uploads')
		expect(mod.SANDBOX_DEFAULT_TOOL_RESULTS_PATH).toBe('/mnt/user-data/tool_results')
		expect(mod.SANDBOX_DEFAULT_TRANSCRIPTS_PATH).toBe('/mnt/transcripts')
		expect(mod.SANDBOX_DEFAULT_SKILLS_PARENT).toBe('/mnt/skills')
	})

	it('@namzu/sdk root barrel re-exports the SANDBOX_DEFAULT_*_PATH constants', async () => {
		const mod = await import('@namzu/sdk')
		expect(mod.SANDBOX_DEFAULT_OUTPUTS_PATH).toBe('/mnt/user-data/outputs')
		expect(mod.SANDBOX_DEFAULT_UPLOADS_PATH).toBe('/mnt/user-data/uploads')
		expect(mod.SANDBOX_DEFAULT_TOOL_RESULTS_PATH).toBe('/mnt/user-data/tool_results')
		expect(mod.SANDBOX_DEFAULT_TRANSCRIPTS_PATH).toBe('/mnt/transcripts')
		expect(mod.SANDBOX_DEFAULT_SKILLS_PARENT).toBe('/mnt/skills')
	})
})

describe('renderLayoutMountArgs', () => {
	it('emits one --volume per declared mount with rw on outputs and ro on the rest', () => {
		const args = renderLayoutMountArgs({
			outputs: {
				source: { type: 'hostDir', hostPath: '/h/o' },
				containerPath: '/mnt/user-data/outputs',
			},
			uploads: {
				source: { type: 'hostDir', hostPath: '/h/u' },
				containerPath: '/mnt/user-data/uploads',
			},
			toolResults: {
				source: { type: 'hostDir', hostPath: '/h/tr' },
				containerPath: '/mnt/user-data/tool_results',
			},
			skills: [
				{
					id: 'a',
					source: { type: 'hostDir', hostPath: '/h/s/a' },
					containerPath: '/mnt/skills/a',
				},
				{
					id: 'b',
					source: { type: 'hostDir', hostPath: '/h/s/b' },
					containerPath: '/mnt/skills/b',
				},
			],
			transcripts: {
				source: { type: 'hostDir', hostPath: '/h/ts' },
				containerPath: '/mnt/transcripts',
			},
		})

		expect(args).toEqual([
			'--volume',
			'/h/o:/mnt/user-data/outputs:rw',
			'--volume',
			'/h/u:/mnt/user-data/uploads:ro',
			'--volume',
			'/h/tr:/mnt/user-data/tool_results:ro',
			'--volume',
			'/h/s/a:/mnt/skills/a:ro',
			'--volume',
			'/h/s/b:/mnt/skills/b:ro',
			'--volume',
			'/h/ts:/mnt/transcripts:ro',
		])
	})

	it('emits a single --volume for outputs only when nothing else is declared', () => {
		const args = renderLayoutMountArgs({
			outputs: {
				source: { type: 'hostDir', hostPath: '/h/o' },
				containerPath: '/mnt/user-data/outputs',
			},
		})
		expect(args).toEqual(['--volume', '/h/o:/mnt/user-data/outputs:rw'])
	})
})

describe('renderLayoutMountArgs — regression: no tmpdir-allocated bind sources', () => {
	// Pins the post-mkdtemp-removal contract: every `--volume`
	// source must trace back to a `hostDir.hostPath` the consumer
	// passed in. The old code path mkdtemp'd a workspace under the
	// OS tmpdir and bind-mounted it; that's the EACCES-in-sibling-
	// container bug. If a future refactor reintroduces backend-side
	// host-path allocation, this test fails.
	it('every host-side source comes from a layout-declared hostDir.hostPath', () => {
		const declared = {
			outputs: '/host/declared/outputs',
			uploads: '/host/declared/uploads',
			toolResults: '/host/declared/tool_results',
			skill1: '/host/declared/skill-a',
			skill2: '/host/declared/skill-b',
			transcripts: '/host/declared/transcripts',
		}
		const args = renderLayoutMountArgs({
			outputs: {
				source: { type: 'hostDir', hostPath: declared.outputs },
				containerPath: '/mnt/user-data/outputs',
			},
			uploads: {
				source: { type: 'hostDir', hostPath: declared.uploads },
				containerPath: '/mnt/user-data/uploads',
			},
			toolResults: {
				source: { type: 'hostDir', hostPath: declared.toolResults },
				containerPath: '/mnt/user-data/tool_results',
			},
			skills: [
				{
					id: 'a',
					source: { type: 'hostDir', hostPath: declared.skill1 },
					containerPath: '/mnt/skills/a',
				},
				{
					id: 'b',
					source: { type: 'hostDir', hostPath: declared.skill2 },
					containerPath: '/mnt/skills/b',
				},
			],
			transcripts: {
				source: { type: 'hostDir', hostPath: declared.transcripts },
				containerPath: '/mnt/transcripts',
			},
		})

		// Extract every `<host>:<container>:<mode>` triple and assert
		// the host side is one of the declared paths. The positive
		// declaredSet check is the load-bearing assertion; the negative
		// regex assertions on tmpdir prefixes that earlier rounds
		// carried were dropped because the positive set is exhaustive
		// — no `hostPath` from outside the consumer's declared map can
		// satisfy this.
		const tripleArgs = args.filter((_, i) => i % 2 === 1)
		const declaredSet = new Set(Object.values(declared))
		for (const triple of tripleArgs) {
			const [hostPath] = triple.split(':')
			expect(declaredSet.has(hostPath ?? '')).toBe(true)
		}
	})
})
