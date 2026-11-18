import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InstalledSkillsView } from '../shared/config-lists-protocol.js'
import type { ConfigSettingsView } from '../shared/config-settings-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'
import { cleanErrorMessage, plainErrorText } from './plain-error.js'
import { desktopSettingsFileError, isSettingsFileError } from './settings-file-error.js'

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
export interface ConfigListTools {
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
	Partial<Pick<DesktopApi, 'onEvent' | 'pickFolder' | 'existingFolders' | 'installedSkills'>>

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
						[path]: plainErrorText(failure, 'save the setting'),
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
					[path]: plainErrorText(failure, 'save the setting'),
				}))
		}
		if (live.current) setConfirmation(undefined)
	}, [api, confirmation, reset])
	const dismiss = useCallback(() => {
		// A cancelled question puts the typed value back to the saved one.
		if (confirmation) reset(confirmation.path)
		setConfirmation(undefined)
	}, [confirmation, reset])
	const pick = api?.pickFolder
	const exist = api?.existingFolders
	const skills = api?.installedSkills
	const tools = useMemo<ConfigListTools>(
		() => ({
			...(pick ? { pickFolder: () => pick() } : {}),
			...(exist ? { existingFolders: (paths: string[]) => exist(paths) } : {}),
			...(skills ? { installedSkills: () => skills(projectId) } : {}),
		}),
		[pick, exist, skills, projectId],
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
