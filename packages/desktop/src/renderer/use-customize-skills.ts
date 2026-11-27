import { useCallback, useEffect, useRef, useState } from 'react'
import type {
	SkillCatalogView,
	SkillFileTextView,
	SkillFilesView,
} from '../shared/customize-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'
import { type SkillRowModel, basicSkillRows } from './customize-model.js'
import { plainErrorText } from './plain-error.js'
import { SKILLS_CHANGED_EVENT } from './skill-create.js'

type Bridge = Pick<DesktopApi, 'skillCatalog' | 'installedSkills' | 'skillFiles' | 'skillFile'>

export interface CustomizeSkills {
	/** Undefined until the first answer. */
	rows?: SkillRowModel[]
	/** The engine has no catalog: only names and places are known. */
	basic: boolean
	/** The engine can add, make and remove skills. */
	canManage: boolean
	error?: string
	reload: () => void
}

/**
 * The skills the page lists: the engine's catalog, or from an engine without one the installed
 * list (a name and a place each). Read when the page opens, when the window comes back into focus
 * and when a skill is saved from a conversation.
 */
export function useCustomizeSkills(
	api: Bridge | undefined,
	projectId: string | undefined,
	disabled: unknown,
	active: boolean,
): CustomizeSkills {
	const [state, setState] = useState<{
		rows?: SkillRowModel[]
		basic: boolean
		canManage: boolean
		error?: string
	}>({
		basic: false,
		canManage: false,
	})
	const latest = useRef(0)
	const disabledRef = useRef(disabled)
	disabledRef.current = disabled
	const reload = useCallback(() => {
		if (!api || !active) return
		const mine = ++latest.current
		const read = async () => {
			const catalog: SkillCatalogView | null | undefined = api.skillCatalog
				? await api.skillCatalog(projectId)
				: null
			if (catalog)
				return {
					rows: catalog.skills as SkillRowModel[],
					basic: false,
					canManage: catalog.canManage === true,
				}
			const installed = api.installedSkills ? await api.installedSkills(projectId) : null
			return {
				rows: installed ? basicSkillRows(installed.skills, disabledRef.current) : [],
				basic: true,
				canManage: false,
			}
		}
		read().then(
			(next) => {
				if (latest.current === mine) setState(next)
			},
			(failure) => {
				if (latest.current === mine)
					setState((current) => ({
						...current,
						error: plainErrorText(failure, 'read the skills'),
					}))
			},
		)
	}, [api, projectId, active])
	useEffect(() => {
		if (!active) return
		reload()
		window.addEventListener('focus', reload)
		window.addEventListener(SKILLS_CHANGED_EVENT, reload)
		return () => {
			latest.current++
			window.removeEventListener('focus', reload)
			window.removeEventListener(SKILLS_CHANGED_EVENT, reload)
		}
	}, [active, reload])
	return { ...state, reload }
}

/** One skill folder's files, read when its Contents tab opens. */
export function useSkillFiles(
	api: Pick<Bridge, 'skillFiles'> | undefined,
	name: string,
	projectId: string | undefined,
	wanted: boolean,
): { files?: SkillFilesView['files']; error?: string } {
	const [state, setState] = useState<{
		key: string
		files?: SkillFilesView['files']
		error?: string
	}>({ key: '' })
	const key = `${projectId ?? ''}:${name}`
	useEffect(() => {
		if (!wanted || !api?.skillFiles) return
		let current = true
		api.skillFiles(name, projectId).then(
			(answer) => current && setState({ key, files: answer?.files ?? [] }),
			(failure) =>
				current && setState({ key, error: plainErrorText(failure, 'read the skill’s files') }),
		)
		return () => {
			current = false
		}
	}, [api, name, projectId, wanted, key])
	return state.key === key ? { files: state.files, error: state.error } : {}
}

/** One text file of a skill, read when it is opened. */
export function useSkillFileText(
	api: Pick<Bridge, 'skillFile'> | undefined,
	name: string,
	path: string | undefined,
	projectId: string | undefined,
): { text?: SkillFileTextView; error?: string } {
	const [state, setState] = useState<{ key: string; text?: SkillFileTextView; error?: string }>({
		key: '',
	})
	const key = `${projectId ?? ''}:${name}:${path ?? ''}`
	useEffect(() => {
		if (!path || !api?.skillFile) return
		let current = true
		api.skillFile(name, path, projectId).then(
			(answer) =>
				current &&
				setState(
					answer ? { key, text: answer } : { key, error: 'This file cannot be shown here.' },
				),
			(failure) => current && setState({ key, error: plainErrorText(failure, 'read the file') }),
		)
		return () => {
			current = false
		}
	}, [api, name, path, projectId, key])
	return state.key === key ? { text: state.text, error: state.error } : {}
}
