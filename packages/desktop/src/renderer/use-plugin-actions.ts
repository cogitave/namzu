import { useCallback, useState } from 'react'
import type { PluginUpdateView } from '../shared/customize-protocol.js'
import type { DesktopApi } from '../shared/protocol.js'
import type { ComposerPlugin, ComposerPluginInventory } from './composer-plugins.js'
import { type UpdateState, recordScope, updateState } from './customize-plugins-model.js'
import { notify } from './notify.js'
import { plainErrorText } from './plain-error.js'
import { PLUGINS_CHANGED_EVENT } from './plugin-create.js'

type Bridge = Pick<
	DesktopApi,
	| 'enablePlugin'
	| 'checkPluginUpdate'
	| 'updatePlugin'
	| 'uninstallPlugin'
	| 'removeMarketplace'
	| 'updateMarketplaces'
>

export interface PluginActions {
	/** The last update check of each plugin, by its id. */
	states: Readonly<Record<string, UpdateState>>
	/** An update that needs a yes before it is applied. */
	pendingUpdate?: { plugin: ComposerPlugin; update: PluginUpdateView }
	clearPendingUpdate: () => void
	/** The marketplace being refreshed. */
	updatingMarket?: string
	setSaved: (plugin: ComposerPlugin, on: boolean) => Promise<void>
	check: (plugin: ComposerPlugin) => Promise<void>
	update: (plugin: ComposerPlugin) => Promise<void>
	remove: (plugin: ComposerPlugin, deleteData: boolean) => Promise<void>
	updateMarket: (name: string) => Promise<void>
	removeMarket: (name: string) => Promise<void>
}

const changed = () => window.dispatchEvent(new Event(PLUGINS_CHANGED_EVENT))

/**
 * What the Plugins tab does to plugins Namzu installed and to the marketplaces: the saved yes or
 * no, the update check, the update, and the removals. Each one answers through a notice and then
 * tells the page to read the plugins again.
 */
export function usePluginActions(
	api: Bridge,
	projectId: string | undefined,
	live: {
		view?: ComposerPluginInventory
		change: (plugin: ComposerPlugin) => Promise<void>
		canChange: (p: ComposerPlugin) => boolean
	},
): PluginActions {
	const [states, setStates] = useState<Record<string, UpdateState>>({})
	const [pendingUpdate, setPendingUpdate] = useState<PluginActions['pendingUpdate']>()
	const [updatingMarket, setUpdatingMarket] = useState<string>()
	const put = useCallback(
		(id: string, state: UpdateState | undefined) =>
			setStates((all) => {
				const next = { ...all }
				if (state) next[id] = state
				else delete next[id]
				return next
			}),
		[],
	)

	const setSaved = async (plugin: ComposerPlugin, on: boolean) => {
		const scope = recordScope(plugin)
		if (!plugin.id || !scope || !api.enablePlugin) return
		const answer = await api.enablePlugin({ id: plugin.id, scope, enabled: on }, projectId)
		if (!answer) throw new Error('Update Namzu to change plugins from here.')
		// A conversation that is open follows when it can; one that is working keeps what it loaded.
		if (live.view?.live && live.canChange(plugin) && (plugin.status === 'enabled') !== on)
			await live.change(plugin)
		notify(`Turned ${on ? 'on' : 'off'} ${plugin.name}`, { tone: 'success' })
		changed()
	}

	const check = async (plugin: ComposerPlugin) => {
		const id = plugin.id
		if (!id || !api.checkPluginUpdate) return
		put(id, { kind: 'checking' })
		try {
			const answer = await api.checkPluginUpdate({ id }, projectId)
			put(id, answer ? updateState(answer) : { kind: 'failed' })
		} catch {
			put(id, { kind: 'failed' })
		}
	}

	const update = async (plugin: ComposerPlugin) => {
		const id = plugin.id
		if (!id || !api.updatePlugin) return
		put(id, { kind: 'updating' })
		try {
			const answer = await api.updatePlugin({ id }, projectId)
			if (!answer) throw new Error('Update Namzu to update plugins from here.')
			if (answer.outcome === 'needs-consent') {
				setPendingUpdate({ plugin, update: answer })
				put(id, undefined)
				return
			}
			put(id, undefined)
			notify(answer.message ?? `Updated ${plugin.name} to ${answer.to}.`, { tone: 'success' })
			changed()
		} catch (failure) {
			put(id, undefined)
			notify(plainErrorText(failure, 'update the plugin'), { tone: 'error' })
		}
	}

	const remove = async (plugin: ComposerPlugin, deleteData: boolean) => {
		const scope = recordScope(plugin)
		if (!plugin.id || !scope || !api.uninstallPlugin) return
		const answer = await api.uninstallPlugin(
			{ id: plugin.id, scope, confirm: true, ...(deleteData ? { deleteData: true } : {}) },
			projectId,
		)
		if (!answer) throw new Error('Update Namzu to remove plugins from here.')
		put(plugin.id, undefined)
		notify(`Removed ${plugin.name}.`, { tone: 'success' })
		changed()
	}

	const updateMarket = async (name: string) => {
		if (!api.updateMarketplaces) return
		setUpdatingMarket(name)
		try {
			const answer = await api.updateMarketplaces({ name }, projectId)
			const result = answer?.results.find((item) => item.name === name)
			if (!result || result.outcome === 'failed')
				notify(result?.error ?? 'The marketplace could not be updated.', { tone: 'error' })
			else notify(`Marketplace "${name}" updated.`, { tone: 'success' })
			changed()
		} catch (failure) {
			notify(plainErrorText(failure, 'update the marketplace'), { tone: 'error' })
		} finally {
			setUpdatingMarket(undefined)
		}
	}

	const removeMarket = async (name: string) => {
		if (!api.removeMarketplace) return
		const answer = await api.removeMarketplace({ name, confirm: true }, projectId)
		if (!answer) throw new Error('Update Namzu to remove marketplaces from here.')
		notify(`Marketplace "${name}" removed.`, { tone: 'success' })
		changed()
	}

	return {
		states,
		pendingUpdate,
		clearPendingUpdate: () => setPendingUpdate(undefined),
		updatingMarket,
		setSaved,
		check,
		update,
		remove,
		updateMarket,
		removeMarket,
	}
}
