import { normalizeAzureEndpoint, parseAzurePaste } from '../integrations/decision/paste.js'
import type { SetupDraft } from '../integrations/decision/setup.js'
import type { ChoicePickerOption } from './ChoicePicker.js'

/**
 * The short flow that connects a decision model: an offer after a model is picked, a choice of
 * what to connect, then one to three fields. Pure: the terminal holds the state and does the
 * saving; this says what is asked next and what a typed answer means.
 */

export const DECISION_OFFER_TITLE =
	"Use a decision model to make Namzu's small decisions more accurate?"

export const DECISION_OFFER_VALUES = ['yes', 'later', 'never'] as const
export type DecisionOfferValue = (typeof DECISION_OFFER_VALUES)[number]

export const DECISION_OFFER_OPTIONS: readonly ChoicePickerOption[] = [
	{
		label: 'Yes',
		description: 'Connect one. It sees short excerpts of a turn for the points you turn on.',
	},
	{ label: 'Not now', description: 'Ask again after a later model pick, at most once a day.' },
	{ label: "Don't ask again", description: 'You can still connect one by hand in the config.' },
]

export const DECISION_KIND_VALUES = ['azure', 'http'] as const
export const DECISION_KIND_OPTIONS: readonly ChoicePickerOption[] = [
	{ label: 'Azure AI Foundry', description: 'Paste the Keys and Endpoint text from the portal.' },
	{ label: 'My own server (HTTP)', description: 'An address, and a key if it wants one.' },
]

export type DecisionStep =
	| 'azure-paste'
	| 'azure-endpoint'
	| 'azure-key'
	| 'azure-deployment'
	| 'http-url'
	| 'http-key'
	| 'http-model'

export interface DecisionPromptSpec {
	readonly step: DecisionStep
	readonly title: string
	readonly placeholder: string
	readonly emptyNotice: string
	readonly initialValue: string
	readonly mask?: boolean
	readonly allowEmpty?: boolean
}

export function decisionPrompt(
	step: DecisionStep,
	hints: { readonly deployments?: readonly string[] } = {},
): DecisionPromptSpec {
	switch (step) {
		case 'azure-paste':
			return {
				step,
				title: 'Azure AI Foundry',
				placeholder:
					'Paste the Keys and Endpoint text · the key is saved privately and never shown',
				emptyNotice: 'Paste the endpoint and key, or press Esc to cancel.',
				initialValue: '',
				mask: true,
			}
		case 'azure-endpoint':
			return {
				step,
				title: 'Endpoint',
				placeholder: 'https://<resource>.services.ai.azure.com',
				emptyNotice: 'An endpoint is required. Press Esc to cancel.',
				initialValue: '',
			}
		case 'azure-key':
			return {
				step,
				title: 'Key (optional)',
				placeholder: 'Paste the key, or press Enter to use your Azure sign-in (az login)',
				emptyNotice: '',
				initialValue: '',
				mask: true,
				allowEmpty: true,
			}
		case 'azure-deployment': {
			const found = hints.deployments ?? []
			return {
				step,
				title: found.length > 0 ? `Deployment (found: ${found.join(', ')})` : 'Deployment name',
				placeholder: 'The name you gave the deployment in the portal',
				emptyNotice: 'A deployment name is required. Press Esc to cancel.',
				initialValue: found[0] ?? '',
			}
		}
		case 'http-url':
			return {
				step,
				title: 'Server address',
				placeholder: 'http://127.0.0.1:8080/decide',
				emptyNotice: 'An address is required. Press Esc to cancel.',
				initialValue: '',
			}
		case 'http-key':
			return {
				step,
				title: 'Key (optional)',
				placeholder: 'Press Enter if the server needs none · a key is saved privately',
				emptyNotice: '',
				initialValue: '',
				mask: true,
				allowEmpty: true,
			}
		case 'http-model':
			return {
				step,
				title: 'Model name (optional)',
				placeholder: 'Press Enter to let the server choose',
				emptyNotice: '',
				initialValue: '',
				allowEmpty: true,
			}
	}
}

export type DecisionAdvance =
	| { readonly kind: 'ask'; readonly draft: SetupDraft; readonly step: DecisionStep }
	/** The deployment is the one thing missing and the resource may list it: look, then ask. */
	| { readonly kind: 'list-deployments'; readonly draft: SetupDraft }
	| { readonly kind: 'done'; readonly draft: SetupDraft }
	| {
			readonly kind: 'retry'
			readonly draft: SetupDraft
			readonly step: DecisionStep
			readonly notice: string
	  }

function azureNext(draft: SetupDraft): DecisionAdvance {
	if (!draft.endpoint) return { kind: 'ask', draft, step: 'azure-endpoint' }
	if (draft.key === undefined) return { kind: 'ask', draft, step: 'azure-key' }
	if (!draft.deployment) {
		return draft.key
			? { kind: 'list-deployments', draft }
			: { kind: 'ask', draft, step: 'azure-deployment' }
	}
	return { kind: 'done', draft }
}

/** What a typed answer means for the step it answered. */
export function advanceDecisionFlow(
	draft: SetupDraft,
	step: DecisionStep,
	value: string,
): DecisionAdvance {
	const text = value.trim()
	switch (step) {
		case 'azure-paste': {
			const parsed = parseAzurePaste(text)
			if (!parsed.endpoint && !parsed.key) {
				return {
					kind: 'retry',
					draft,
					step,
					notice:
						'No endpoint or key found in that text. Paste the Keys and Endpoint page, or Esc to cancel.',
				}
			}
			// A key pasted alone is a key, and the next step asks for the endpoint.
			return azureNext({
				...draft,
				...(parsed.endpoint ? { endpoint: parsed.endpoint } : {}),
				...(parsed.key ? { key: parsed.key } : {}),
				...(parsed.deployment ? { deployment: parsed.deployment } : {}),
			})
		}
		case 'azure-endpoint': {
			const parsed = parseAzurePaste(text)
			const endpoint = normalizeAzureEndpoint(text)
			if (!endpoint) {
				return {
					kind: 'retry',
					draft,
					step,
					notice:
						'That is not an Azure endpoint (https://<resource>.services.ai.azure.com or .cognitiveservices.azure.com).',
				}
			}
			return azureNext({
				...draft,
				endpoint,
				...(parsed.deployment && !draft.deployment ? { deployment: parsed.deployment } : {}),
			})
		}
		case 'azure-key':
			return azureNext({ ...draft, key: text })
		case 'azure-deployment':
			return azureNext({ ...draft, deployment: text })
		case 'http-url': {
			let url: URL
			try {
				url = new URL(text)
			} catch {
				return {
					kind: 'retry',
					draft,
					step,
					notice: 'That is not an address (http://host:port/path).',
				}
			}
			if (url.protocol !== 'http:' && url.protocol !== 'https:') {
				return {
					kind: 'retry',
					draft,
					step,
					notice: 'The address must start with http:// or https://.',
				}
			}
			return { kind: 'ask', draft: { ...draft, url: text }, step: 'http-key' }
		}
		case 'http-key':
			return {
				kind: 'ask',
				draft: { ...draft, ...(text ? { key: text } : {}) },
				step: 'http-model',
			}
		case 'http-model':
			return { kind: 'done', draft: { ...draft, ...(text ? { model: text } : {}) } }
	}
}
