import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InstalledSkillsView } from '../shared/config-lists-protocol.js'
import type { ConfigSettingsView } from '../shared/config-settings-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'
import { cleanErrorMessage, plainErrorText } from './plain-error.js'
import { desktopSettingsFileError, isSettingsFileError } from './settings-file-error.js'

/**
 * What a refused save says. The engine words a refusal for the person ("not a site: ... write
 * scheme://host"), but it need not start with a capital, so the general rule for error text would
 * hide it behind "Couldn't save the setting". A setting's refusal is shown as written; a failure of
 * the system (a file that cannot be written, a lost connection) still goes through that rule.
 */
export function saveRefusalText(failure: unknown): string {
	const cleaned = cleanErrorMessage(failure instanceof Error ? failure.message : String(failure))
	const system =
		/\b(?:E[A-Z]{3,}|ERR_[A-Z_]+)\b|errno|syscall|\bat [^ ]+:\d+|(?:fetch failed|network|permission denied|no such file)/
	if (cleaned !== '' && cleaned.length <= 300 && !system.test(cleaned)) return cleaned
	return plainErrorText(failure, 'save the setting')
}

export interface ConfigSettingConfirmation {
	path: string
	value: unknown
	token: string
	message: string
}

/**
 * What a list row asks the app for beyond the setting itself: the system folder picker, a check of
 * which folders exist, and the installed skills. Each is absent when this window has no bridge
 * for it, and the row then falls back to typing.
 */
/** The models one provider offers, as the composer's own list reads them. */
export interface ModelChoiceGroup {
	provider: string
	label: string
	models: { id: string; label: string }[]
}

export interface ConfigListTools {
	/** The models Desktop already knows, grouped by provider. Read when a model field is first used. */
	modelChoices?: () => Promise<ModelChoiceGroup[]>
	pickFolder?: () => Promise<string | null>
	existingFolders?: (paths: string[]) => Promise<string[]>
	installedSkills?: () => Promise<InstalledSkillsView | null>
}

export interface ConfigSettingsControls {
	/** What list rows may ask the app for. */
	tools?: ConfigListTools
	/** Undefined until the engine answers, or when this window has no engine. */
	view: ConfigSettingsView | undefined
	/** Why the list could not be read, in words. Empty once a later read worked. */
	loadError: string
	/** A read is under way and nothing has been shown yet. */
	loading: boolean
	/** Reads the engine's list again (the Try again button; focus and file changes call it too). */
	reload: () => void
	/**
	 * Counts, by setting, the times its typed draft must be dropped: a cancelled confirmation, a
	 * confirmed save or a cleared value. A field keyed on it starts again from the saved value.
	 */
	resets: Record<string, number>
	/** Drops the typed, unsaved value of one setting, so its field shows what is saved. */
	discard: (path: string) => void
	/** The last failed change, by setting, so the message sits under the field that caused it. */
	errors: Record<string, string>
	/** Saves. Resolves true when the engine took it; false when it refused or a confirmation is open. */
	change: (path: string, value?: unknown) => Promise<boolean>
	confirmation: ConfigSettingConfirmation | undefined
	confirm: () => Promise<void>
	dismiss: () => void
}

type Api = Pick<DesktopApi, 'configSettings' | 'setConfigSetting'> &
	Partial<
		Pick<
			DesktopApi,
			| 'onEvent'
			| 'pickFolder'
			| 'existingFolders'
			| 'installedSkills'
			| 'palProviders'
			| 'palModels'
		>
	>

/**
 * The providers that can answer and each one's models, from the lists the composer and the Pal
 * page already read. A provider whose list cannot be read is left out, and its default model is
 * offered instead when it names one.
 */
export async function readModelChoices(
	providers: () => ReturnType<DesktopApi['palProviders']>,
	models: DesktopApi['palModels'],
): Promise<ModelChoiceGroup[]> {
	const view = await providers()
	const groups = await Promise.all(
		view.available.map(async (provider): Promise<ModelChoiceGroup> => {
			const group: ModelChoiceGroup = { provider: provider.id, label: provider.label, models: [] }
			try {
				const list = await models(provider.id)
				group.models = list.models.map((model) => ({ id: model.id, label: model.label }))
			} catch {
				if (provider.defaultModel)
					group.models = [{ id: provider.defaultModel, label: provider.defaultModel }]
			}
			return group
		}),
	)
	return groups.filter((group) => group.models.length > 0)
}

export function useConfigSettings(
	api: Api | undefined,
	active: boolean,
	/** The open project, so the skills list is the one that project's engine sees. */
	projectId?: string,
): ConfigSettingsControls {
	const [view, setView] = useState<ConfigSettingsView>()
	const [loadError, setLoadError] = useState('')
	const [loading, setLoading] = useState(false)
	const [resets, setResets] = useState<Record<string, number>>({})
	const [errors, setErrors] = useState<Record<string, string>>({})
	const [confirmation, setConfirmation] = useState<ConfigSettingConfirmation>()
	const live = useRef(true)
	useEffect(() => {
		live.current = true
		return () => {
			live.current = false
		}
	}, [])
	const latest = useRef(0)
	const modelChoices = useRef<Promise<ModelChoiceGroup[]> | undefined>(undefined)
	const reload = useCallback(() => {
		if (!active || !api?.configSettings) return
		const mine = ++latest.current
		setLoading(true)
		void api.configSettings().then(
			(value) => {
				if (!live.current || latest.current !== mine) return
				setView(value)
				setLoadError('')
				setLoading(false)
			},
			(failure) => {
				if (!live.current || latest.current !== mine) return
				// What was shown stays; the error says the list is no longer current.
				const said = cleanErrorMessage(
					failure instanceof Error ? failure.message : String(failure ?? ''),
				)
				setLoadError(
					isSettingsFileError(said)
						? desktopSettingsFileError(said)
						: plainErrorText(failure, 'read your settings'),
				)
				setLoading(false)
			},
		)
	}, [api, active])
	// Read when the page opens, when the window comes back into focus, and when main says the
	// config file changed elsewhere. Nothing polls.
	useEffect(() => {
		if (!active || !api?.configSettings) return
		reload()
		window.addEventListener('focus', reload)
		const stop = api.onEvent?.((event) => {
			if (event.kind === 'config-file-changed') reload()
			// A key was saved or removed: the providers that can answer, and their models, changed.
			if (event.kind === 'providers-changed') modelChoices.current = undefined
		})
		return () => {
			window.removeEventListener('focus', reload)
			stop?.()
		}
	}, [api, active, reload])
	const reset = useCallback((path: string) => {
		setResets((current) => ({ ...current, [path]: (current[path] ?? 0) + 1 }))
	}, [])
	const change = useCallback(
		async (path: string, value?: unknown) => {
			if (!api?.setConfigSetting) return false
			setErrors((current) => ({ ...current, [path]: '' }))
			try {
				const result = await api.setConfigSetting({
					path,
					...(value === undefined ? {} : { value }),
				})
				if (!live.current) return false
				if (result.status === 'confirm') {
					setConfirmation({ path, value, token: result.token, message: result.message })
					return false
				}
				setView(result.view)
				setLoadError('')
				if (value === undefined) reset(path)
				return true
			} catch (failure) {
				if (live.current)
					setErrors((current) => ({
						...current,
						[path]: saveRefusalText(failure),
					}))
				return false
			}
		},
		[api, reset],
	)
	const confirm = useCallback(async () => {
		if (!confirmation || !api?.setConfigSetting) return
		const { path } = confirmation
		try {
			const result = await api.setConfigSetting(
				{
					path,
					...(confirmation.value === undefined ? {} : { value: confirmation.value }),
				},
				confirmation.token,
			)
			if (live.current && result.status === 'saved') {
				setView(result.view)
				setLoadError('')
				reset(path)
			}
		} catch (failure) {
			// An expired confirmation or a refused value lands under the setting, not as a crash.
			if (live.current)
				setErrors((current) => ({
					...current,
					[path]: saveRefusalText(failure),
				}))
		}
		if (live.current) setConfirmation(undefined)
	}, [api, confirmation, reset])
	const dismiss = useCallback(() => {
		// A cancelled question puts the typed value back to the saved one.
		if (confirmation) reset(confirmation.path)
		setConfirmation(undefined)
	}, [confirmation, reset])
	const providersApi = api?.palProviders
	const modelsApi = api?.palModels
	const readChoices = useCallback(() => {
		if (!providersApi || !modelsApi) return undefined
		if (!modelChoices.current) {
			const read = readModelChoices(
				() => providersApi(),
				(provider) => modelsApi(provider),
			)
			modelChoices.current = read
			// A failed read is tried again the next time a model field is used.
			read.catch(() => {
				if (modelChoices.current === read) modelChoices.current = undefined
			})
		}
		return modelChoices.current
	}, [providersApi, modelsApi])
	const pick = api?.pickFolder
	const exist = api?.existingFolders
	const skills = api?.installedSkills
	const tools = useMemo<ConfigListTools>(
		() => ({
			...(readChoices ? { modelChoices: () => readChoices() as Promise<ModelChoiceGroup[]> } : {}),
			...(pick ? { pickFolder: () => pick() } : {}),
			...(exist ? { existingFolders: (paths: string[]) => exist(paths) } : {}),
			...(skills ? { installedSkills: () => skills(projectId) } : {}),
		}),
		[readChoices, pick, exist, skills, projectId],
	)
	return {
		tools,
		view,
		loadError,
		loading: loading && !view,
		reload,
		resets,
		discard: reset,
		errors,
		change,
		confirmation,
		confirm,
		dismiss,
	}
}
