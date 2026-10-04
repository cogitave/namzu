import { CloudIcon, ProviderIcons, ServerIcon } from './icons.js'

export type ModelBrand = 'anthropic' | 'openai' | 'google' | 'deepseek'
const modelFamilyBrands: ReadonlyMap<string, ModelBrand> = new Map([
	['claude', 'anthropic'],
	['gemini', 'google'],
	['deepseek', 'deepseek'],
])

/** Model identity takes precedence over the service routing its requests. */
export function selectedModelBrand(model: string): ModelBrand | undefined {
	const id = model.trim().toLowerCase()
	const namespace = id.includes('/') ? id.split('/')[0] : undefined
	if (
		namespace === 'anthropic' ||
		namespace === 'openai' ||
		namespace === 'google' ||
		namespace === 'deepseek'
	)
		return namespace
	const name = id.split('/').at(-1) ?? ''
	const familyBrand = modelFamilyBrands.get(name.split('-')[0] ?? '')
	if (familyBrand) return familyBrand
	if (/^(?:gpt(?:-|$)|o[134](?:-|$))/.test(name)) return 'openai'
	return undefined
}

/** Prefer a real model mark, then a known provider, then the route's location. */
export function SelectedModelIcon({ model, provider }: { model: string; provider?: string }) {
	if (!model.trim()) return null
	const brand = selectedModelBrand(model)
	const providerId =
		provider === 'codex' || provider === 'codex-cli'
			? 'openai'
			: provider === 'claude-code'
				? 'anthropic'
				: provider
	const providerIcon = providerId ? ProviderIcons.get(providerId) : undefined
	const local = providerId === 'ollama' || providerId === 'lmstudio'
	const Icon =
		(brand ? ProviderIcons.get(brand) : undefined) ??
		providerIcon ??
		(local ? ServerIcon : CloudIcon)
	const identity = brand ?? (providerIcon ? `provider:${providerId}` : local ? 'local' : 'remote')
	return (
		<Icon aria-hidden="true" data-selected-model-icon={identity} className="selected-model-icon" />
	)
}
