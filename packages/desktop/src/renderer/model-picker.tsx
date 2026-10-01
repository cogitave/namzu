import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Tabs } from '@base-ui/react/tabs'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelCatalogueView, ProviderView } from '../shared/protocol.js'
import { ComposerControl, ComposerControlChevron } from './composer-control.js'
import {
	CheckIcon,
	CloudIcon,
	LoaderCircleIcon,
	ProviderIcons,
	SearchIcon,
	ServerIcon,
	XIcon,
} from './icons.js'
import { Button } from './ui/button.js'
import { Input } from './ui/input.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import { Tooltip, TooltipPopup, TooltipTrigger } from './ui/tooltip.js'
import './model-picker.css'

export interface ModelChoice {
	provider: string
	model: string
	label?: string
}
type Provider = ProviderView['available'][number]
type Catalogue = { loading: boolean; value?: ModelCatalogueView; error?: string }

function ProviderMark({ provider }: { provider: Provider }) {
	const Icon =
		ProviderIcons.get(provider.id === 'codex' ? 'openai' : provider.id) ??
		(['ollama', 'lmstudio'].includes(provider.id) ? ServerIcon : CloudIcon)
	return (
		<span className="model-provider-mark" aria-hidden="true">
			<Icon />
		</span>
	)
}

export function ModelPicker({
	providers,
	choice,
	disabled,
	onChange,
	projectId,
	sessionId,
}: {
	providers: ProviderView
	choice: ModelChoice
	disabled: boolean
	onChange: (choice: ModelChoice) => void
	projectId: string
	sessionId?: string
}) {
	const [open, setOpen] = useState(false)
	const provider = providers.available.find((item) => item.id === choice.provider)
	const model = choice.label || choice.model || provider?.defaultModel || 'Select model'
	useEffect(() => {
		if (disabled) setOpen(false)
	}, [disabled])
	const scope = `${projectId}:${sessionId ?? ''}`
	const previousScope = useRef(scope)
	useEffect(() => {
		if (previousScope.current !== scope) {
			previousScope.current = scope
			setOpen(false)
		}
	}, [scope])
	return (
		<Popover open={open && previousScope.current === scope && !disabled} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<ComposerControl
						className="model-picker-trigger"
						disabled={disabled || providers.available.length === 0}
						aria-label="Select model"
					/>
				}
			>
				<span className="truncate">{model}</span>
				<ComposerControlChevron />
			</PopoverTrigger>
			<PopoverPopup
				side="top"
				align="end"
				sideOffset={8}
				padding="none"
				aria-label="Model picker"
				className="model-picker-popup"
			>
				<ModelBrowser
					key={`${projectId}:${sessionId ?? ''}`}
					providers={providers}
					choice={choice}
					projectId={projectId}
					sessionId={sessionId}
					onChoose={(next, close) => {
						if (disabled) return
						onChange(next)
						if (close) setOpen(false)
					}}
				/>
			</PopoverPopup>
		</Popover>
	)
}

function ModelBrowser({
	providers,
	choice,
	projectId,
	sessionId,
	onChoose,
}: {
	providers: ProviderView
	choice: ModelChoice
	projectId: string
	sessionId?: string
	onChoose: (choice: ModelChoice, close?: boolean) => void
}) {
	const [providerId, setProviderId] = useState(choice.provider)
	const [catalogues, setCatalogues] = useState<Record<string, Catalogue>>({})
	const requested = useRef(new Set<string>())
	const mounted = useRef(true)
	const [searching, setSearching] = useState(false)
	const [query, setQuery] = useState('')
	const search = useRef<HTMLInputElement>(null)
	const results = useRef<HTMLDivElement>(null)
	const [custom, setCustom] = useState(false)
	const [customModel, setCustomModel] = useState(choice.model)
	const active =
		providers.available.find((provider) => provider.id === providerId) ?? providers.available[0]
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])
	const load = useCallback(
		(provider: Provider) => {
			if (requested.current.has(provider.id)) return
			requested.current.add(provider.id)
			setCatalogues((all) => ({ ...all, [provider.id]: { loading: true } }))
			void window.namzu
				.models(projectId, provider.id, sessionId)
				.then((value) => {
					if (mounted.current)
						setCatalogues((all) => ({ ...all, [provider.id]: { loading: false, value } }))
				})
				.catch(() => {
					if (mounted.current)
						setCatalogues((all) => ({
							...all,
							[provider.id]: {
								loading: false,
								error: 'Could not load these models. Try again.',
							},
						}))
				})
		},
		[projectId, sessionId],
	)
	useEffect(() => {
		const targets = searching ? providers.available : active ? [active] : []
		for (const provider of targets) load(provider)
	}, [active, providers.available, searching, load])
	useEffect(() => {
		if (searching) search.current?.focus({ preventScroll: true })
	}, [searching])
	const shownProviders = searching ? providers.available : active ? [active] : []
	const models = shownProviders.flatMap((provider) =>
		(catalogues[provider.id]?.value?.models ?? []).map((model) => ({ ...model, provider })),
	)
	const filtered = models.filter((model) =>
		`${model.label} ${model.id} ${model.provider.label}`
			.toLowerCase()
			.includes(query.trim().toLowerCase()),
	)
	const loading = shownProviders.some(
		(provider) => !catalogues[provider.id] || catalogues[provider.id]?.loading,
	)
	const errors = shownProviders.filter((provider) => catalogues[provider.id]?.error)
	const retry = (id: string) => {
		requested.current.delete(id)
		const provider = providers.available.find((provider) => provider.id === id)
		if (provider) load(provider)
	}
	const notices = shownProviders.flatMap((provider) => {
		const notice = catalogues[provider.id]?.value?.notice
		return notice ? [{ provider, notice }] : []
	})
	const modelKey = (provider: string, model: string) => JSON.stringify([provider, model])
	const lineUp = (
		<div className="model-lineup">
			<header className="model-picker-heading">
				{searching ? (
					<div className="model-search">
						<SearchIcon aria-hidden="true" />
						<Input
							nativeInput
							unstyled
							ref={search}
							type="search"
							aria-label="Search models"
							placeholder="Search all models…"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.nativeEvent.isComposing) return
								if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
									const rows = results.current?.querySelectorAll<HTMLElement>('[role="radio"]')
									const row = event.key === 'ArrowDown' ? rows?.[0] : rows?.[rows.length - 1]
									if (row) {
										event.preventDefault()
										row.focus()
									}
								} else if (event.key === 'Enter' && filtered[0]) {
									event.preventDefault()
									const next = filtered[0]
									onChoose({ provider: next.provider.id, model: next.id, label: next.label }, true)
								}
							}}
						/>
						<Button
							size="icon-xs"
							variant="ghost-muted"
							aria-label="Close model search"
							onClick={() => {
								setSearching(false)
								setQuery('')
							}}
						>
							<XIcon />
						</Button>
					</div>
				) : (
					<>
						<span>Models</span>
						<Button variant="ghost-muted" size="xs" onClick={() => setSearching(true)}>
							<span>Quick search</span>
							<SearchIcon aria-hidden="true" />
						</Button>
					</>
				)}
			</header>
			<div ref={results} className="model-picker-list">
				<RadioGroup
					aria-label={searching ? 'Search results' : `${active?.label ?? ''} models`}
					value={modelKey(
						choice.provider,
						choice.model ||
							providers.available.find((provider) => provider.id === choice.provider)
								?.defaultModel ||
							'',
					)}
					onValueChange={(value: string) => {
						const next = filtered.find((model) => modelKey(model.provider.id, model.id) === value)
						if (next) onChoose({ provider: next.provider.id, model: next.id, label: next.label })
					}}
				>
					{filtered.map((model) => (
						<Radio.Root
							key={modelKey(model.provider.id, model.id)}
							value={modelKey(model.provider.id, model.id)}
							nativeButton
							render={<button type="button" />}
							className="model-picker-row"
							aria-label={`${model.provider.label} ${model.label}`}
							onClick={(event) => {
								event.preventDefault()
								onChoose({ provider: model.provider.id, model: model.id, label: model.label }, true)
							}}
							onKeyDown={(event) => {
								if (event.key === 'Enter') {
									event.preventDefault()
									onChoose(
										{ provider: model.provider.id, model: model.id, label: model.label },
										true,
									)
								}
							}}
						>
							<ProviderMark provider={model.provider} />
							<span className="model-picker-name">
								<span title={model.id}>{model.label}</span>
								{searching && <small>{model.provider.label}</small>}
								{model.note && <small>{model.note}</small>}
							</span>
							<Radio.Indicator className="model-picker-checked">
								<CheckIcon aria-hidden="true" />
							</Radio.Indicator>
						</Radio.Root>
					))}
				</RadioGroup>
				{loading && (
					<output className="model-picker-status">
						<LoaderCircleIcon className="model-picker-loading" aria-hidden="true" />
						Loading models…
					</output>
				)}
				{!loading && filtered.length === 0 && errors.length === 0 && (
					<output className="model-picker-status">
						{query ? 'No matching listed models.' : 'No models listed.'}
					</output>
				)}
				{errors.map((provider) => (
					<div key={provider.id} className="model-picker-status" role="alert">
						<span>
							{provider.label}: {catalogues[provider.id]?.error}
						</span>
						<Button
							variant="ghost-muted"
							size="xs"
							onClick={() => retry(provider.id)}
							aria-label={`Retry ${provider.label} models`}
						>
							Retry
						</Button>
					</div>
				))}
				{notices.map(({ provider, notice }) => (
					<p key={provider.id} className="model-picker-notice">
						{searching && `${provider.label}: `}
						{notice}
						<Button
							variant="ghost-muted"
							size="xs"
							onClick={() => retry(provider.id)}
							disabled={catalogues[provider.id]?.loading}
							aria-label={`Retry ${provider.label} models`}
						>
							Retry
						</Button>
					</p>
				))}
			</div>
			{active && (
				<div className="model-custom">
					{custom ? (
						<form
							onSubmit={(event) => {
								event.preventDefault()
								if (customModel.trim())
									onChoose({ provider: active.id, model: customModel.trim() }, true)
							}}
						>
							<label htmlFor="custom-model">Model ID · {active.label}</label>
							<div>
								<Input
									nativeInput
									id="custom-model"
									aria-label="Model"
									value={customModel}
									onChange={(event) => setCustomModel(event.target.value)}
									placeholder={active.defaultModel}
								/>
								<Button
									type="submit"
									variant="ghost-muted"
									size="xs"
									disabled={!customModel.trim()}
									aria-label="Use model"
								>
									<CheckIcon />
								</Button>
							</div>
						</form>
					) : (
						<Button
							variant="ghost-muted"
							size="xs"
							onClick={() => {
								setCustomModel(
									choice.provider === active.id
										? choice.model || active.defaultModel
										: active.defaultModel,
								)
								setCustom(true)
							}}
						>
							Use a model ID…
						</Button>
					)}
				</div>
			)}
		</div>
	)
	return (
		<Tabs.Root
			orientation="vertical"
			value={active?.id ?? null}
			onValueChange={(value) => {
				setProviderId(String(value))
				setQuery('')
				setSearching(false)
				setCustom(false)
			}}
			className="model-provider-tabs"
			onKeyDown={(event) => {
				if (event.key === '/' && !(event.target instanceof HTMLInputElement)) {
					event.preventDefault()
					setSearching(true)
				}
			}}
		>
			<Tabs.List aria-label="Model providers" className="model-provider-list">
				{providers.available.map((provider) => (
					<Tooltip key={provider.id}>
						<TooltipTrigger
							render={
								<Tabs.Tab
									value={provider.id}
									aria-label={provider.label}
									className="model-provider-tab"
								/>
							}
						>
							<ProviderMark provider={provider} />
						</TooltipTrigger>
						<TooltipPopup side="left">{provider.label}</TooltipPopup>
					</Tooltip>
				))}
			</Tabs.List>
			{active && (
				<Tabs.Panel key={active.id} value={active.id} className="model-provider-panel">
					{lineUp}
				</Tabs.Panel>
			)}
		</Tabs.Root>
	)
}
