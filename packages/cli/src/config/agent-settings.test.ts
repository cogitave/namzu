import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	GET_SETTINGS_TOOL,
	SET_SETTING_TOOL,
	createAgentSettingsTools,
} from './agent-settings-tools.js'
import {
	AGENT_SETTINGS,
	type AgentSettingsContext,
	type DesktopPreferences,
	NOT_FOR_THE_AGENT,
	applyAgentChange,
	describeAgentChange,
	planAgentChange,
	readAgentSettings,
} from './agent-settings.js'
import { SETTING_DESCRIPTORS } from './settings-descriptors.js'
import { userConfigPath } from './user-config.js'

const toolContext = {} as unknown as ToolContext

describe('agent settings', () => {
	let home: string
	let project: string
	let saved: Record<string, unknown>
	let sent: { key: string; value: string | boolean }[]
	let desktop: DesktopPreferences
	const ctx = (extra: Partial<AgentSettingsContext> = {}): AgentSettingsContext => ({
		home,
		env: {},
		cwd: project,
		managedPath: join(home, 'no-managed.json'),
		...extra,
	})
	const withDesktop = () => ctx({ desktop })
	const userFile = () => readFileSync(userConfigPath({ home, env: {} }), 'utf8')

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'namzu-agent-settings-'))
		project = join(home, 'project')
		mkdirSync(project)
		saved = {}
		sent = []
		desktop = {
			read: () => saved,
			write: (key, value) => {
				sent.push({ key, value })
			},
		}
	})
	afterEach(() => rmSync(home, { recursive: true, force: true }))

	describe('the allow-list', () => {
		it('names exactly the rows the plan allows, each once', () => {
			expect(
				AGENT_SETTINGS.map((row) => `${row.id}=${row.owner === 'engine' ? row.path : row.key}`),
			).toEqual([
				'archive_inactive_conversations=archiveInactive',
				'branch_prefix=worktrees.branchPrefix',
				'label_conversations_by_status=statusMarks',
				'closing_summary=closingSummary',
				'output_style=outputStyle',
				'prompt_suggestions=promptSuggestions',
				'permission_request_notifications=notifyPermission',
				'question_notifications=notifyQuestion',
				'finished_response_notifications=notifyTaskComplete',
				'response_error_notifications=notifyError',
				'draw_attention=attentionSignals',
				'notification_sound=notificationSound',
				'keep_awake_while_working=keepAwakeWhileWorking',
				'keep_awake_on_battery=keepAwakeOnBattery',
			])
		})

		it('only lists engine rows whose descriptor is a switch, a choice or a line of text', () => {
			for (const row of AGENT_SETTINGS) {
				if (row.owner !== 'engine') continue
				const descriptor = SETTING_DESCRIPTORS.find((entry) => entry.path === row.path)
				expect(descriptor, row.path).toBeDefined()
				expect(['toggle', 'select', 'text']).toContain(descriptor?.control.kind)
			}
		})

		it('never lists a security or trust key', () => {
			const roots =
				/^(permissions|permissionChecks|permissionLayers|sandbox|browser|web|mcpServers|hooks|disableHooks|plugins|skills|computerUse|model|routing|smallModel|decision|telemetry|updates|profiles)(\.|$)/
			for (const row of AGENT_SETTINGS) {
				const path = row.owner === 'engine' ? row.path : row.key
				expect(path, row.id).not.toMatch(roots)
			}
		})
	})

	describe('reading', () => {
		it('lists engine settings with their values and the facts the agent may only read', () => {
			const report = readAgentSettings(ctx())
			expect(report.settings.map((row) => row.setting)).toEqual([
				'archive_inactive_conversations',
				'branch_prefix',
				'label_conversations_by_status',
				'closing_summary',
				'output_style',
				'prompt_suggestions',
			])
			const archive = report.settings[0]
			expect(archive).toMatchObject({
				name: 'Archive inactive conversations',
				value: 'never',
				valueText: 'Never',
			})
			expect(report.facts.map((fact) => fact.name)).toEqual([
				'Default permission mode',
				'Bypass permissions mode allowed',
				'Auto mode removed',
				'Computer use on',
				'Default model',
			])
			expect(report.facts[0]?.value).toBe('Ask before risky actions')
			expect(report.facts[3]?.value).toBe('off')
		})

		it('adds the Desktop rows only with the app, and reads their saved values', () => {
			saved = { notifyPermission: 'badge', keepAwakeWhileWorking: true }
			const report = readAgentSettings(withDesktop())
			const byId = new Map(report.settings.map((row) => [row.setting, row]))
			expect(byId.get('permission_request_notifications')).toMatchObject({
				name: 'Permission requests',
				value: 'badge',
				valueText: 'Badge only',
			})
			expect(byId.get('keep_awake_while_working')).toMatchObject({ value: true, valueText: 'on' })
			expect(byId.get('notification_sound')).toMatchObject({ value: 'none', valueText: 'None' })
		})

		it('says a value is decided by the administrator, and by whom', () => {
			const managedPath = join(home, 'managed.json')
			writeFileSync(managedPath, JSON.stringify({ closingSummary: false }))
			const row = readAgentSettings(ctx({ managedPath })).settings.find(
				(entry) => entry.setting === 'closing_summary',
			)
			expect(row).toMatchObject({ value: false, locked: 'Decided by your administrator.' })
		})
	})

	describe('planning a change', () => {
		it('refuses anything not on the list with the one sentence', () => {
			for (const setting of [
				'permissions.defaultMode',
				'defaultMode',
				'sandbox.enabled',
				'browser.sites',
				'computerUse.enabled',
				'allowBypassMode',
				'mcpServers',
				'hooks',
				'telemetry',
				'model',
				'updates.auto',
				'',
			]) {
				expect(planAgentChange(ctx(), { setting, value: true }), setting).toEqual({
					ok: false,
					reason: NOT_FOR_THE_AGENT,
				})
			}
		})

		it('does not offer a Desktop row where there is no app', () => {
			expect(planAgentChange(ctx(), { setting: 'notification_sound', value: 'none' })).toEqual({
				ok: false,
				reason: NOT_FOR_THE_AGENT,
			})
		})

		it('says the old and new value in the words Settings uses, never a key', () => {
			const planned = planAgentChange(ctx(), {
				setting: 'archive_inactive_conversations',
				value: '7d',
			})
			expect(planned).toMatchObject({
				ok: true,
				change: {
					name: 'Archive inactive conversations',
					from: 'Never',
					to: 'After 7 days',
					unchanged: false,
				},
			})
			expect(
				describeAgentChange(ctx(), { setting: 'archive_inactive_conversations', value: '7d' }),
			).toEqual({
				setting: 'Archive inactive conversations',
				from: 'Never',
				to: 'After 7 days',
			})
		})

		it('reads a switch from words and a choice by its label', () => {
			expect(planAgentChange(ctx(), { setting: 'closing_summary', value: 'off' })).toMatchObject({
				ok: true,
				change: { value: false, to: 'off', from: 'on' },
			})
			expect(
				planAgentChange(withDesktop(), { setting: 'notification_sound', value: 'System sound' }),
			).toMatchObject({ ok: true, change: { value: 'system', to: 'System sound' } })
		})

		it('refuses a value the setting does not take, naming what it takes', () => {
			expect(
				planAgentChange(ctx(), { setting: 'archive_inactive_conversations', value: '2d' }),
			).toEqual({
				ok: false,
				reason: 'Archive inactive conversations takes one of: never, 1d, 7d, 30d.',
			})
			expect(planAgentChange(ctx(), { setting: 'closing_summary', value: 'maybe' })).toMatchObject({
				ok: false,
			})
			expect(
				planAgentChange(withDesktop(), { setting: 'notification_sound', value: 'loud' }),
			).toMatchObject({
				ok: false,
			})
			expect(
				planAgentChange(ctx(), { setting: 'output_style', value: 'x'.repeat(601) }),
			).toMatchObject({
				ok: false,
			})
		})

		it("refuses a value the setting's own checks refuse", () => {
			const planned = planAgentChange(ctx(), { setting: 'branch_prefix', value: 'bad prefix!' })
			expect(planned.ok).toBe(false)
		})

		it('refuses a value an administrator, the environment or the project decides, saying who', () => {
			const managedPath = join(home, 'managed.json')
			writeFileSync(managedPath, JSON.stringify({ closingSummary: false }))
			expect(
				planAgentChange(ctx({ managedPath }), { setting: 'closing_summary', value: true }),
			).toEqual({
				ok: false,
				reason:
					'Closing summary is decided by your administrator, so it cannot be changed here.'.replace(
						'Closing summary',
						'Summary and next steps',
					),
			})
			writeFileSync(join(project, 'namzu.config.json'), JSON.stringify({ statusMarks: false }))
			expect(
				planAgentChange(ctx(), { setting: 'label_conversations_by_status', value: true }),
			).toMatchObject({
				ok: false,
				reason: expect.stringContaining("this project's settings file"),
			})
		})

		it('refuses a Desktop row when the app cannot be read', () => {
			const unreadable: DesktopPreferences = { read: () => undefined, write: () => undefined }
			expect(
				planAgentChange(ctx({ desktop: unreadable }), { setting: 'draw_attention', value: false }),
			).toMatchObject({ ok: false, reason: expect.stringContaining('cannot be read just now') })
		})

		it('marks a change to the value already held as unchanged', () => {
			expect(planAgentChange(ctx(), { setting: 'closing_summary', value: true })).toMatchObject({
				ok: true,
				change: { unchanged: true },
			})
		})
	})

	describe('making a change', () => {
		it('writes an engine row through the writer Settings uses, so Settings shows it', async () => {
			const planned = planAgentChange(ctx(), {
				setting: 'archive_inactive_conversations',
				value: '7d',
			})
			if (!planned.ok) throw new Error(planned.reason)
			const said = await applyAgentChange(ctx(), planned.change)
			expect(said).toContain('After 7 days')
			expect(userFile()).toContain('archiveInactive: 7d')
			expect(
				readAgentSettings(ctx()).settings.find(
					(row) => row.setting === 'archive_inactive_conversations',
				)?.value,
			).toBe('7d')
		})

		it('writes a nested key and clears text with an empty line', async () => {
			const prefix = planAgentChange(ctx(), { setting: 'branch_prefix', value: 'work' })
			if (!prefix.ok) throw new Error(prefix.reason)
			await applyAgentChange(ctx(), prefix.change)
			expect(userFile()).toContain('branchPrefix: work')
			const style = planAgentChange(ctx(), { setting: 'output_style', value: 'short and plain' })
			if (!style.ok) throw new Error(style.reason)
			await applyAgentChange(ctx(), style.change)
			expect(userFile()).toContain('outputStyle: short and plain')
			const cleared = planAgentChange(ctx(), { setting: 'output_style', value: '' })
			if (!cleared.ok) throw new Error(cleared.reason)
			await applyAgentChange(ctx(), cleared.change)
			expect(userFile()).not.toContain('outputStyle')
		})

		it('hands a Desktop row to the app instead of writing a file', async () => {
			const planned = planAgentChange(withDesktop(), {
				setting: 'keep_awake_while_working',
				value: true,
			})
			if (!planned.ok) throw new Error(planned.reason)
			await applyAgentChange(withDesktop(), planned.change)
			expect(sent).toEqual([{ key: 'keepAwakeWhileWorking', value: true }])
		})

		it('writes nothing for a value already held', async () => {
			const planned = planAgentChange(ctx(), { setting: 'closing_summary', value: true })
			if (!planned.ok) throw new Error(planned.reason)
			expect(await applyAgentChange(ctx(), planned.change)).toContain('already on')
		})
	})

	describe('the tools', () => {
		it('offers get_settings and set_setting, and set_setting always needs a person', () => {
			const [get, set] = createAgentSettingsTools(ctx())
			expect([get?.name, set?.name]).toEqual([GET_SETTINGS_TOOL, SET_SETTING_TOOL])
			expect(get?.requiresApproval).toBeUndefined()
			expect(set?.requiresApproval?.({ setting: 'closing_summary', value: false })).toBe(true)
			expect(set?.isDestructive?.({})).toBe(false)
		})

		it('names no config key in the descriptions', () => {
			for (const tool of createAgentSettingsTools(ctx()))
				expect(tool.description).not.toMatch(/archiveInactive|statusMarks|notifyError|worktrees\./)
		})

		it('refuses before any card when the change would be refused anyway', async () => {
			const set = createAgentSettingsTools(ctx())[1]
			expect(
				await set?.refuseBeforeReview?.({ setting: 'sandbox.enabled', value: false }, toolContext),
			).toEqual({
				error: NOT_FOR_THE_AGENT,
			})
			expect(
				await set?.refuseBeforeReview?.({ setting: 'closing_summary', value: false }, toolContext),
			).toBeUndefined()
		})

		it('draws no card for a value the setting already has', async () => {
			const set = createAgentSettingsTools(withDesktop())[1]
			const same = { setting: 'notification_sound', value: 'none' }
			expect(await set?.refuseBeforeReview?.(same, toolContext)).toEqual({
				error: 'Notification sound is already None, so nothing was changed.',
			})
			expect(set?.presentCall?.(same)).toEqual({ kind: 'generic', label: 'Change a setting' })
		})

		it('stops offering itself once the switch is turned off after the tools were built', async () => {
			const [get, set] = createAgentSettingsTools(ctx())
			expect((await get?.execute({}, toolContext))?.success).toBe(true)
			mkdirSync(join(home, '.namzu'), { recursive: true })
			writeFileSync(userConfigPath({ home, env: {} }), 'agentSettings: false\n')
			const off = 'Letting Namzu change settings is off.'
			expect(await get?.execute({}, toolContext)).toMatchObject({ success: false, error: off })
			expect(
				await set?.refuseBeforeReview?.({ setting: 'closing_summary', value: false }, toolContext),
			).toEqual({ error: off })
			expect(
				await set?.execute({ setting: 'closing_summary', value: false }, toolContext),
			).toMatchObject({ success: false, error: off })
		})

		it('runs a change and reports it, or reports the refusal', async () => {
			const set = createAgentSettingsTools(ctx())[1]
			const done = await set?.execute({ setting: 'prompt_suggestions', value: false }, toolContext)
			expect(done).toMatchObject({ success: true })
			expect(userFile()).toContain('promptSuggestions: false')
			const refused = await set?.execute({ setting: 'hooks', value: false }, toolContext)
			expect(refused).toMatchObject({ success: false, error: NOT_FOR_THE_AGENT })
		})

		it('returns the report as JSON', async () => {
			const get = createAgentSettingsTools(ctx())[0]
			const result = await get?.execute({}, toolContext)
			expect(result?.success).toBe(true)
			expect(JSON.parse(result?.output ?? '{}').settings).toHaveLength(6)
		})

		it('shows the plain change on the call, never a key', () => {
			const set = createAgentSettingsTools(ctx())[1]
			expect(
				set?.presentCall?.({ setting: 'archive_inactive_conversations', value: '30d' }),
			).toEqual({
				kind: 'generic',
				label: 'Change Archive inactive conversations: Never to After 30 days',
			})
			expect(set?.presentCall?.({ setting: 'hooks', value: true })).toEqual({
				kind: 'generic',
				label: 'Change a setting',
			})
			expect(createAgentSettingsTools(ctx())[0]?.presentCall?.({})).toEqual({
				kind: 'generic',
				label: 'Read settings',
			})
		})
	})
})
