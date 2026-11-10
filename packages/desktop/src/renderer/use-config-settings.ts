import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConfigSettingsView } from '../shared/config-settings-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'
import { plainErrorText } from './plain-error.js'

export interface ConfigSettingConfirmation {
	path: string
	value: unknown
	token: string
	message: string
}

export interface ConfigSettingsControls {
	/** Undefined until the engine answers, or when this window has no engine. */
	view: ConfigSettingsView | undefined
	/** Why the list could not be read, in words. */
	loadError: string
	/** The last failed change, by setting, so the message sits under the field that caused it. */
	errors: Record<string, string>
	/** Saves. Resolves true when the engine took it; false when it refused or a confirmation is open. */
	change: (path: string, value?: unknown) => Promise<boolean>
	confirmation: ConfigSettingConfirmation | undefined
	confirm: () => Promise<void>
	dismiss: () => void
}

type Api = Pick<DesktopApi, 'configSettings' | 'setConfigSetting'>

export function useConfigSettings(api: Api | undefined, active: boolean): ConfigSettingsControls {
	const [view, setView] = useState<ConfigSettingsView>()
	const [loadError, setLoadError] = useState('')
	const [errors, setErrors] = useState<Record<string, string>>({})
	const [confirmation, setConfirmation] = useState<ConfigSettingConfirmation>()
	const live = useRef(true)
	useEffect(() => {
		live.current = true
		return () => {
			live.current = false
		}
	}, [])
	useEffect(() => {
		if (!active || !api?.configSettings) return
		void api.configSettings().then(
			(value) => live.current && setView(value),
			(failure) => live.current && setLoadError(plainErrorText(failure, 'read your settings')),
		)
	}, [api, active])
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
		[api],
	)
	const confirm = useCallback(async () => {
		if (!confirmation || !api?.setConfigSetting) return
		const result = await api.setConfigSetting(
			{
				path: confirmation.path,
				...(confirmation.value === undefined ? {} : { value: confirmation.value }),
			},
			confirmation.token,
		)
		if (result.status === 'saved') setView(result.view)
		setConfirmation(undefined)
	}, [api, confirmation])
	const dismiss = useCallback(() => setConfirmation(undefined), [])
	return { view, loadError, errors, change, confirmation, confirm, dismiss }
}
