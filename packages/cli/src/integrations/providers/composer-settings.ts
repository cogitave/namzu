import { type ProviderChainMember, type ReasoningEffort, withProviderFallback } from '@namzu/sdk'
import { type PermissionMode, isPermissionMode } from '../../permissions/mode.js'
import { modelReasoningView } from './model-reasoning.js'
import { runPickerProviderOperation } from './picker-operation.js'

export interface ComposerModelSettings {
	readonly effortLevels?: readonly ReasoningEffort[]
	readonly effortDefault?: ReasoningEffort
	readonly notice?: string
}

/** Resolve the same usable provider chain's menu without creating an agent or running a turn. */
export async function resolveProviderReasoning(
	members: readonly ProviderChainMember[],
	signal?: AbortSignal,
): Promise<ComposerModelSettings> {
	try {
		signal?.throwIfAborted()
		const primaryModel = members[0]?.model
		const capabilityView = withProviderFallback(
			await Promise.all(
				members.map(async (member) => {
					const memberModel = member.model ?? primaryModel ?? ''
					const known = member.provider.reasoningEffortLevelsFor
						? member.provider.reasoningEffortLevelsFor(memberModel)
						: member.provider.effortLevelsFor?.(memberModel)
					const catalogue =
						known === undefined && member.provider.listModels
							? await runPickerProviderOperation(
									signal,
									(operationSignal) =>
										member.provider.listModels?.(operationSignal) ?? Promise.resolve([]),
								).catch((error) => {
									if (signal?.aborted) throw error
									return []
								})
							: []
					return {
						...member,
						provider: modelReasoningView(member.provider, memberModel, catalogue),
					}
				}),
			),
		)
		signal?.throwIfAborted()
		const offered = capabilityView.reasoningEffortLevelsFor
			? capabilityView.reasoningEffortLevelsFor(primaryModel ?? '')
			: capabilityView.effortLevelsFor?.(primaryModel ?? '')
		const effortLevels = offered === undefined ? undefined : Object.freeze([...offered])
		try {
			const effortDefault = capabilityView.reasoningEffortDefaultFor?.(primaryModel ?? '')
			if (
				effortDefault !== undefined &&
				effortLevels !== undefined &&
				!effortLevels.includes(effortDefault)
			) {
				return {
					effortLevels,
					notice: `The provider published default effort "${effortDefault}" outside its exact menu. Directional effort shortcuts require an explicit selection.`,
				}
			}
			return { effortLevels, effortDefault }
		} catch (error) {
			return {
				effortLevels,
				notice: `The default reasoning effort could not be established for this session: ${describeError(error)}`,
			}
		}
	} catch (error) {
		if (signal?.aborted) throw signal.reason
		return {
			notice: `Reasoning effort levels could not be established for this session: ${describeError(error)}`,
		}
	}
}

export interface ComposerSendSettings {
	readonly effort?: ReasoningEffort
	readonly permissionMode: PermissionMode
}

/** Validate after opening the exact session; a saved menu cannot authorize a different route. */
export function validateComposerSendSettings(
	value: unknown,
	session: { readonly reasoningEffortLevels?: readonly ReasoningEffort[] },
	defaultPermissionMode: PermissionMode = 'prompt',
): ComposerSendSettings {
	if (
		value !== undefined &&
		(typeof value !== 'object' || value === null || Array.isArray(value))
	) {
		throw new Error('Invalid message settings.')
	}
	const settings = value as
		| { readonly effort?: unknown; readonly permissionMode?: unknown }
		| undefined
	const permissionMode = settings?.permissionMode ?? defaultPermissionMode
	if (!isPermissionMode(permissionMode)) throw new Error('Invalid permission mode.')
	const effort = settings?.effort
	if (effort === undefined) return { permissionMode }
	if (
		typeof effort !== 'string' ||
		!session.reasoningEffortLevels?.includes(effort as ReasoningEffort)
	) {
		throw new Error(
			'This reasoning effort is not available for the selected model. Choose it again.',
		)
	}
	return { effort: effort as ReasoningEffort, permissionMode }
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
