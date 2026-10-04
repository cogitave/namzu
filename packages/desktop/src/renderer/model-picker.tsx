import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Tabs } from '@base-ui/react/tabs'
import type { ReasoningEffort } from '@namzu/sdk'
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { ComposerModelSettings, ModelCatalogueView, ProviderView } from '../shared/protocol.js'
import { ComposerControl, ComposerControlChevron } from './composer-control.js'
import { ComposerEffort } from './composer-settings.js'
import {
	CheckIcon,
	CloudIcon,
	LoaderCircleIcon,
	ProviderIcons,
	SearchIcon,
	ServerIcon,
	XIcon,
} from './icons.js'
import { SelectedModelIcon } from './selected-model-icon.js'
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
type Catalogue = {
	loading: boolean
	value?: ModelCatalogueView
	error?: string
}

function ProviderMark({ provider }: { provider: Provider }) {
	const Icon =
		ProviderIcons.get(
			provider.id === 'codex' || provider.id === 'codex-cli'
				? 'openai'
				: provider.id === 'claude-code'
					? 'anthropic'
					: provider.id,
		) ?? (['ollama', 'lmstudio'].includes(provider.id) ? ServerIcon : CloudIcon)
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
	loadCatalogue,
	positionerClassName,
	settings,
	effort,
	onEffortChange,
}: {
	providers: ProviderView
	choice: ModelChoice
	disabled: boolean
	onChange: (choice: ModelChoice) => void
	projectId: string
	sessionId?: string
	loadCatalogue?: (provider: string) => Promise<ModelCatalogueView>
	positionerClassName?: string
	settings?: ComposerModelSettings | null
	effort?: ReasoningEffort
	onEffortChange?: (effort: ReasoningEffort | undefined) => void
}) {
	const [open, setOpen] = useState(false)
	const provider = providers.available.find((item) => item.id === choice.provider)
	const model = choice.label || choice.model || provider?.defaultModel || 'Select model'
	useEffect(() => {
		if (disabled) setOpen(false)
	}, [disabled])
	const scope = `${projectId}:${sessionId ?? ''}`
	const effortScope = JSON.stringify([
		projectId,
		sessionId,
		choice.provider,
		choice.model || provider?.defaultModel || '',
	])
	const showEffort = Boolean(onEffortChange && (settings?.effortLevels?.length || effort))
	const effortControl =
		showEffort && onEffortChange ? (
			<ComposerEffort
				scope={effortScope}
				effortLevels={settings?.effortLevels}
				effortDefault={settings?.effortDefault}
				effort={effort}
				disabled={disabled}
				onChange={onEffortChange}
				positionerClassName={positionerClassName}
			/>
		) : null
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
				<SelectedModelIcon
					model={choice.model || provider?.defaultModel || ''}
					provider={choice.provider}
				/>
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
				positionerClassName={positionerClassName}
			>
				<div className="model-picker-body">
					<ModelBrowser
						key={`${projectId}:${sessionId ?? ''}`}
						providers={providers}
						choice={choice}
						projectId={projectId}
						sessionId={sessionId}
						loadCatalogue={loadCatalogue}
						effortControl={effortControl}
						settingsNotice={settings?.notice}
						onChoose={(next, close) => {
							if (disabled) return
							onChange(next)
							if (close && !onEffortChange) setOpen(false)
						}}
					/>
				</div>
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
	loadCatalogue,
	effortControl,
	settingsNotice,
}: {
	providers: ProviderView
	choice: ModelChoice
	projectId: string
	sessionId?: string
	loadCatalogue?: (provider: string) => Promise<ModelCatalogueView>
	onChoose: (choice: ModelChoice, close?: boolean) => void
	effortControl?: ReactNode
	settingsNotice?: string
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
	const multipleProviders = providers.available.length > 1
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
			void (
				loadCatalogue
					? loadCatalogue(provider.id)
					: window.namzu.models(projectId, provider.id, sessionId)
			)
				.then((value) => {
					if (mounted.current)
						setCatalogues((all) => ({
							...all,
							[provider.id]: { loading: false, value },
						}))
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
		[projectId, sessionId, loadCatalogue],
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
		(catalogues[provider.id]?.value?.models ?? []).map((model) => ({
			...model,
			provider,
		})),
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
	const sharedNotes = new Map<string, string>()
	for (const provider of shownProviders) {
		const listed = catalogues[provider.id]?.value?.models ?? []
		const note = listed[0]?.note?.trim()
		if (note && listed.length > 1 && listed.every((model) => model.note?.trim() === note))
			sharedNotes.set(provider.id, note)
	}
	const groups = shownProviders.flatMap((provider) => {
		const rows = filtered.filter((model) => model.provider.id === provider.id)
		return rows.length ? [{ provider, rows }] : []
	})
	const modelKey = (provider: string, model: string) => JSON.stringify([provider, model])
	const selectedModel =
		choice.model ||
		providers.available.find((provider) => provider.id === choice.provider)?.defaultModel ||
		''
	const hasSelectedRow = groups.some(
		({ provider, rows }) =>
			provider.id === choice.provider && rows.some((row) => row.id === selectedModel),
	)
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
									onChoose(
										{
											provider: next.provider.id,
											model: next.id,
											label: next.label,
										},
										true,
									)
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
						<div className="model-picker-heading-copy">
							<span className="model-picker-title">Select model</span>
							{multipleProviders && (
								<span className="model-picker-provider-label" title={active?.label}>
									{active?.label}
								</span>
							)}
						</div>
						<Button
							variant="ghost-muted"
							size="icon-xs"
							aria-label="Search models"
							title="Search models (/)"
							onClick={() => setSearching(true)}
						>
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
						if (next)
							onChoose({
								provider: next.provider.id,
								model: next.id,
								label: next.label,
							})
					}}
				>
					{groups.map(({ provider, rows }) => (
						<fieldset
							key={provider.id}
							className="model-picker-section"
							aria-label={provider.label}
						>
							{searching && (
								<legend className="model-picker-section-title">{provider.label}</legend>
							)}
							{rows.map((model) => (
								<div
									key={modelKey(model.provider.id, model.id)}
									className="model-picker-row-wrap"
									data-has-effort={
										(model.provider.id === choice.provider &&
											model.id === selectedModel &&
											Boolean(effortControl)) ||
										undefined
									}
								>
									<Radio.Root
										value={modelKey(model.provider.id, model.id)}
										nativeButton
										render={<button type="button" />}
										className="model-picker-row"
										aria-label={`${model.provider.label} ${model.label}`}
										onClick={(event) => {
											event.preventDefault()
											onChoose(
												{
													provider: model.provider.id,
													model: model.id,
													label: model.label,
												},
												true,
											)
										}}
										onKeyDown={(event) => {
											if (event.key === 'Enter') {
												event.preventDefault()
												onChoose(
													{
														provider: model.provider.id,
														model: model.id,
														label: model.label,
													},
													true,
												)
											}
										}}
									>
										<span className="model-picker-name">
											<span title={`${model.label} · ${model.id}`}>{model.label}</span>
											{model.note && sharedNotes.get(model.provider.id) !== model.note.trim() && (
												<small>{model.note}</small>
											)}
										</span>
										<span className="model-picker-selection" aria-hidden="true">
											<Radio.Indicator className="model-picker-checked">
												<CheckIcon aria-hidden="true" />
											</Radio.Indicator>
										</span>
									</Radio.Root>
									{model.provider.id === choice.provider &&
										model.id === selectedModel &&
										effortControl}
								</div>
							))}
						</fieldset>
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
			</div>
			{!searching && !hasSelectedRow && effortControl && (
				<div className="model-picker-current">
					<span className="model-picker-section-title">Current model</span>
					<div className="model-picker-current-row model-picker-row-wrap" data-has-effort>
						<span className="model-picker-name" title={selectedModel}>
							<span>{choice.label || selectedModel}</span>
						</span>
						{effortControl}
					</div>
				</div>
			)}
			{(errors.length > 0 || notices.length > 0 || sharedNotes.size > 0 || settingsNotice) && (
				<div className="model-picker-feedback" aria-label="Model catalogue information">
					{settingsNotice && <p className="model-picker-settings-notice">{settingsNotice}</p>}
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
					{shownProviders.map((provider) => {
						const note = sharedNotes.get(provider.id)
						if (!note || note === catalogues[provider.id]?.value?.notice?.trim()) return null
						return (
							<p key={provider.id} className="model-picker-shared-note">
								{searching && `${provider.label}: `}
								{note}
							</p>
						)
					})}
					{notices.map(({ provider, notice }) => (
						<div key={provider.id} className="model-picker-notice">
							<span>
								{searching && `${provider.label}: `}
								{notice}
							</span>
							<Button
								variant="ghost-muted"
								size="xs"
								onClick={() => retry(provider.id)}
								disabled={catalogues[provider.id]?.loading}
								aria-label={`Retry ${provider.label} models`}
							>
								Retry
							</Button>
						</div>
					))}
				</div>
			)}
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
	const searchShortcut = (event: KeyboardEvent) => {
		if (event.key === '/' && !(event.target instanceof HTMLInputElement)) {
			event.preventDefault()
			setSearching(true)
		}
	}
	if (!multipleProviders)
		return (
			<div className="model-provider-single" onKeyDown={searchShortcut}>
				{lineUp}
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
			onKeyDown={searchShortcut}
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
