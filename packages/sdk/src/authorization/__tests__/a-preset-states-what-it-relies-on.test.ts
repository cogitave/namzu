import { describe, expect, it } from 'vitest'

import type { SandboxIsolationReport } from '../../types/sandbox/index.js'
import {
	PERMISSION_PRESETS,
	SANDBOXED_PRESET,
	SANDBOXED_SHELL_PRESET,
	SUPERVISED_PRESET,
	UNATTENDED_PRESET,
	UnsupportedPermissionPresetError,
	availablePermissionPresets,
	permissionPreset,
	resolvePermissionPreset,
} from '../permission-presets.js'

/**
 * A permission stance that states what it is relying on.
 *
 * The gate, the sandbox and the approval policy were configured
 * independently and had to agree by hand. `defaultSandboxedGateConfig`
 * auto-approves in-sandbox file mutation on the stated grounds that "the FS
 * boundary is enforced by the sandbox layer" — a claim about a different
 * subsystem, which nothing checked. On a `basic` tier, where the process
 * can read and write the whole host filesystem, that gate keeps
 * auto-approving writes on the strength of a boundary that is not there.
 */

const ALL: SandboxIsolationReport = { filesystem: true, network: true, process: true }
const NONE: SandboxIsolationReport = { filesystem: false, network: false, process: false }
const FS_ONLY: SandboxIsolationReport = { filesystem: true, network: false, process: false }
const FS_AND_PROCESS: SandboxIsolationReport = {
	filesystem: true,
	network: false,
	process: true,
}

describe('a preset refuses a host that cannot back it', () => {
	it('refuses `unattended` on a host with no isolation at all', async () => {
		// The one that matters most. With an auto-approving policy the sandbox
		// is the ONLY boundary left, so the requirement cannot be waived.
		expect(() => resolvePermissionPreset(UNATTENDED_PRESET, NONE)).toThrow(
			UnsupportedPermissionPresetError,
		)
	})

	it('names what is missing, not merely that something is', async () => {
		// So the host can fix the sandbox rather than guess which control it
		// is short of.
		try {
			resolvePermissionPreset(UNATTENDED_PRESET, FS_ONLY)
			throw new Error('expected a refusal')
		} catch (err) {
			expect(err).toBeInstanceOf(UnsupportedPermissionPresetError)
			expect((err as UnsupportedPermissionPresetError).details.missing).toEqual([
				'network',
				'process',
			])
		}
	})

	it('refuses `sandboxed-shell` without process isolation', async () => {
		// A shell auto-approving inside a tier that cannot stop it seeing or
		// signalling host processes is a shell with the run of the machine.
		expect(() => resolvePermissionPreset(SANDBOXED_SHELL_PRESET, FS_ONLY)).toThrow(/process/)
	})

	it('refuses `sandboxed` without filesystem isolation', async () => {
		expect(() => resolvePermissionPreset(SANDBOXED_PRESET, NONE)).toThrow(/filesystem/)
	})

	it('accepts `supervised` anywhere, including a bare host', async () => {
		// It makes no assumption a sandbox could fail to back: every call goes
		// to review.
		expect(() => resolvePermissionPreset(SUPERVISED_PRESET, NONE)).not.toThrow()
	})

	it('does NOT require a control it never spends', async () => {
		// `sandboxed` leaves network to a human, so requiring network
		// isolation would refuse hosts that could safely run it.
		expect(() => resolvePermissionPreset(SANDBOXED_PRESET, FS_ONLY)).not.toThrow()
		expect(() => resolvePermissionPreset(SANDBOXED_SHELL_PRESET, FS_AND_PROCESS)).not.toThrow()
	})

	it('hands back the gate config when the host qualifies', async () => {
		const gate = resolvePermissionPreset(UNATTENDED_PRESET, ALL)

		expect(gate.enabled).toBe(true)
		expect(gate.allowReadOnlyTools).toBe(true)
	})
})

describe('what each preset actually spends', () => {
	it('`unattended` is the only one that auto-approves network', async () => {
		// And it is the only one that requires network isolation. The two
		// facts are the same fact, which is what a preset exists to keep
		// together.
		const categoriesOf = (preset: typeof UNATTENDED_PRESET) =>
			preset.gate.rules?.flatMap((rule) =>
				rule.type === 'allow_by_category' ? rule.categories : [],
			) ?? []

		expect(categoriesOf(UNATTENDED_PRESET)).toContain('network')
		expect(categoriesOf(SANDBOXED_SHELL_PRESET)).not.toContain('network')
		expect(categoriesOf(SANDBOXED_PRESET)).not.toContain('network')

		expect(UNATTENDED_PRESET.requiresIsolation).toContain('network')
		expect(SANDBOXED_SHELL_PRESET.requiresIsolation).not.toContain('network')
	})

	it('`sandboxed-shell` auto-approves shell and requires process isolation', async () => {
		const categories =
			SANDBOXED_SHELL_PRESET.gate.rules?.flatMap((rule) =>
				rule.type === 'allow_by_category' ? rule.categories : [],
			) ?? []

		expect(categories).toContain('shell')
		expect(SANDBOXED_SHELL_PRESET.requiresIsolation).toContain('process')
	})

	it('`supervised` auto-approves nothing, not even a read-only claim', async () => {
		// Read-only auto-approval depends on a tool telling the truth about
		// itself, which is a different kind of trust from the sandbox's.
		expect(SUPERVISED_PRESET.gate.allowReadOnlyTools).toBe(false)
		expect(SUPERVISED_PRESET.requiresIsolation).toEqual([])
	})

	it('only `unattended` expects an auto-approving policy', async () => {
		expect(UNATTENDED_PRESET.expectsApprovalPolicy).toBe('auto-approve')
		for (const preset of [SUPERVISED_PRESET, SANDBOXED_PRESET, SANDBOXED_SHELL_PRESET]) {
			expect(preset.expectsApprovalPolicy).toBe('host')
		}
	})
})

describe('the reverse lookup', () => {
	it('finds every preset by its own name', async () => {
		// Dies to a table whose keys drift from the objects' `name` fields —
		// which is the bug a hand-written table has.
		for (const preset of Object.values(PERMISSION_PRESETS)) {
			expect(permissionPreset(preset.name)).toBe(preset)
		}
	})

	it('answers undefined for a name nobody registered', async () => {
		expect(permissionPreset('yolo')).toBeUndefined()
	})
})

describe('what this host can offer', () => {
	it('lists everything on a fully isolating host, loosest first', async () => {
		expect(availablePermissionPresets(ALL).map((p) => p.name)).toEqual([
			'unattended',
			'sandboxed-shell',
			'sandboxed',
			'supervised',
		])
	})

	it('drops what the host cannot back', async () => {
		expect(availablePermissionPresets(FS_ONLY).map((p) => p.name)).toEqual([
			'sandboxed',
			'supervised',
		])
	})

	it('always ends with `supervised`, and never returns nothing', async () => {
		// A host with no isolation still has a defensible stance. An empty
		// list would leave a caller with no preset to choose and no
		// indication that one was always available.
		const bare = availablePermissionPresets(NONE)

		expect(bare.map((p) => p.name)).toEqual(['supervised'])
	})

	it('agrees with resolve, for every preset and every host', async () => {
		// The two answers must not be able to disagree: a preset listed as
		// available that then refuses is worse than either behaviour alone.
		for (const isolation of [ALL, NONE, FS_ONLY, FS_AND_PROCESS]) {
			const available = new Set(availablePermissionPresets(isolation).map((p) => p.name))
			for (const preset of Object.values(PERMISSION_PRESETS)) {
				const resolves = (() => {
					try {
						resolvePermissionPreset(preset, isolation)
						return true
					} catch {
						return false
					}
				})()
				expect(resolves).toBe(available.has(preset.name))
			}
		}
	})
})
