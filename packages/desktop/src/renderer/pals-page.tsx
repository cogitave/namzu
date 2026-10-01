import { useEffect, useId, useState } from 'react'
import type { ModelCatalogueView, PalInput, PalView, ProviderView } from '../shared/protocol.js'
import {
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	LoaderCircleIcon,
	MonitorIcon,
	PlusIcon,
	SearchIcon,
	SettingsIcon,
	UserRoundIcon,
} from './icons.js'
import { PalAvatar } from './pal-context.js'
import { Button } from './ui/button.js'
import { Input } from './ui/input.js'
import { Popover, PopoverPopup, PopoverTrigger } from './ui/popover.js'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './ui/select.js'
import { Textarea } from './ui/textarea.js'
import './pals-page.css'

export interface PalsPageProps {
	pals: readonly PalView[]
	loading: boolean
	saving: boolean
	error?: string
	editing?: PalView
	creating: boolean
	onStartCreate: () => void
	onEdit: (pal: PalView) => void
	onCancelEdit: () => void
	onSave: (input: PalInput, id?: string) => Promise<void>
	onOpen: (pal: PalView) => void
	loadProviders: () => Promise<ProviderView>
	loadModels: (provider: string) => Promise<ModelCatalogueView>
}

function PalModelField({
	value,
	onChange,
	disabled,
	loadProviders,
	loadModels,
}: {
	value: PalView['model']
	onChange: (value: PalView['model']) => void
	disabled: boolean
	loadProviders: PalsPageProps['loadProviders']
	loadModels: PalsPageProps['loadModels']
}) {
	const [providers, setProviders] = useState<ProviderView>()
	const [providerLoading, setProviderLoading] = useState(true)
	const [providerError, setProviderError] = useState('')
	const [retry, setRetry] = useState(0)
	const [catalogue, setCatalogue] = useState<ModelCatalogueView>()
	const [modelLoading, setModelLoading] = useState(false)
	const [modelError, setModelError] = useState('')
	const [modelRetry, setModelRetry] = useState(0)
	const [query, setQuery] = useState('')
	const [open, setOpen] = useState(false)
	const provider = value?.provider ?? ''
	useEffect(() => {
		let active = true
		setProviderLoading(true)
		setProviderError('')
		void loadProviders().then(
			(result) => {
				if (!active) return
				setProviders(result)
				setProviderLoading(false)
			},
			() => {
				if (!active) return
				setProviderError(
					retry > 0 ? 'Still could not load providers.' : 'Could not load providers.',
				)
				setProviderLoading(false)
			},
		)
		return () => {
			active = false
		}
	}, [loadProviders, retry])
	useEffect(() => {
		let active = true
		setCatalogue(undefined)
		setModelError('')
		setQuery('')
		setOpen(false)
		if (!provider) {
			setModelLoading(false)
			return () => {
				active = false
			}
		}
		setModelLoading(true)
		void loadModels(provider).then(
			(result) => {
				if (!active) return
				setCatalogue(result)
				setModelLoading(false)
			},
			() => {
				if (!active) return
				setModelError(modelRetry > 0 ? 'Still could not load models.' : 'Could not load models.')
				setModelLoading(false)
			},
		)
		return () => {
			active = false
		}
	}, [provider, loadModels, modelRetry])
	useEffect(() => {
		if (disabled) setOpen(false)
	}, [disabled])
	const modelLabel = catalogue?.models.find((model) => model.id === value?.model)?.label
	const search = query.trim().toLocaleLowerCase()
	const models = (catalogue?.models ?? []).filter((model) =>
		`${model.label} ${model.id}`.toLocaleLowerCase().includes(search),
	)
	const providerItems = [
		{ value: '', label: 'Use the configured default' },
		...(providers?.available ?? []).map((item) => ({ value: item.id, label: item.label })),
	]
	if (provider && !providerItems.some((item) => item.value === provider))
		providerItems.push({ value: provider, label: provider })
	return (
		<div className="pal-model-field">
			<span id="pal-provider-label" className="pal-field-label">
				Default model
			</span>
			<Select
				items={providerItems}
				value={provider}
				disabled={disabled || providerLoading}
				onValueChange={(next) => onChange(next ? { provider: next, model: '' } : null)}
			>
				<SelectTrigger aria-labelledby="pal-provider-label" className="pal-provider-trigger">
					<SelectValue />
				</SelectTrigger>
				<SelectPopup>
					{providerItems.map((item) => (
						<SelectItem key={item.value} value={item.value}>
							{item.label}
						</SelectItem>
					))}
				</SelectPopup>
			</Select>
			{provider && (
				<Popover open={open && !disabled} onOpenChange={setOpen}>
					<PopoverTrigger
						render={<Button variant="outline" className="pal-model-trigger" disabled={disabled} />}
						aria-label="Choose Pal model"
					>
						<span>{modelLabel || value?.model || 'Choose a model'}</span>
						<ChevronDownIcon />
					</PopoverTrigger>
					<PopoverPopup
						padding="none"
						align="start"
						className="pal-model-popup"
						aria-label="Pal models"
					>
						<div className="pal-model-search">
							<SearchIcon aria-hidden="true" />
							<Input
								nativeInput
								unstyled
								type="search"
								aria-label="Search Pal models"
								placeholder="Search models…"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
							/>
						</div>
						<div className="pal-model-list">
							{modelLoading && (
								<output className="pal-feedback">
									<LoaderCircleIcon className="pal-loading" />
									Loading models…
								</output>
							)}
							{modelError && (
								<div className="pal-feedback" role="alert">
									<span>{modelError}</span>
									<Button
										size="xs"
										variant="ghost"
										onClick={() => setModelRetry((current) => current + 1)}
									>
										Retry
									</Button>
								</div>
							)}
							{models.map((model) => (
								<Button
									key={model.id}
									variant="ghost"
									className="pal-model-option"
									aria-pressed={value?.model === model.id}
									onClick={() => {
										onChange({ provider, model: model.id })
										setOpen(false)
									}}
								>
									<span>
										<strong>{model.label}</strong>
										{model.note && <small>{model.note}</small>}
									</span>
									{value?.model === model.id && <CheckIcon />}
								</Button>
							))}
							{!modelLoading && !modelError && models.length === 0 && (
								<p className="pal-feedback">
									{search ? 'No matching models.' : 'No models listed.'}
								</p>
							)}
						</div>
						{catalogue?.notice && <p className="pal-model-notice">{catalogue.notice}</p>}
					</PopoverPopup>
				</Popover>
			)}
			{providerLoading && <output className="pal-field-hint">Loading providers…</output>}
			{providerError && (
				<div className="pal-feedback" role="alert">
					<span>{providerError}</span>
					<Button size="xs" variant="ghost" onClick={() => setRetry((current) => current + 1)}>
						Retry
					</Button>
				</div>
			)}
			<p className="pal-field-hint">
				Used for new conversations. You can change models within a conversation.
			</p>
		</div>
	)
}

function PalEditor({
	editing,
	saving,
	error,
	onCancelEdit,
	onSave,
	loadProviders,
	loadModels,
}: Pick<
	PalsPageProps,
	'editing' | 'saving' | 'error' | 'onCancelEdit' | 'onSave' | 'loadProviders' | 'loadModels'
>) {
	const id = useId()
	const [name, setName] = useState(editing?.name ?? '')
	const [purpose, setPurpose] = useState(editing?.purpose ?? '')
	const [model, setModel] = useState<PalView['model']>(editing?.model ?? null)
	const [submitError, setSubmitError] = useState('')
	return (
		<div className="pal-editor">
			<header className="pal-editor-heading">
				<PalAvatar name={name || 'Pal'} />
				<div>
					<h2>{editing ? 'Customize your Pal' : 'Meet your Pal'}</h2>
					<p>{editing ? 'Make this Pal your own.' : 'First, what would you like to call them?'}</p>
				</div>
			</header>
			<form
				onSubmit={(event) => {
					event.preventDefault()
					if (saving || !name.trim() || (model && !model.model)) return
					setSubmitError('')
					void onSave({ name: name.trim(), purpose: purpose.trim(), model }, editing?.id).catch(
						(reason: unknown) =>
							setSubmitError(reason instanceof Error ? reason.message : 'Could not save your Pal.'),
					)
				}}
			>
				<div className="pal-form-field">
					<label htmlFor={`${id}-name`}>Name</label>
					<Input
						nativeInput
						id={`${id}-name`}
						name="name"
						placeholder="Give your Pal a name"
						value={name}
						maxLength={80}
						required
						disabled={saving}
						onChange={(event) => setName(event.target.value)}
						autoComplete="off"
					/>
				</div>
				<div className="pal-form-field">
					<label htmlFor={`${id}-purpose`}>
						What should they help with? <span>Optional</span>
					</label>
					<Textarea
						id={`${id}-purpose`}
						name="purpose"
						placeholder="Research, coding, planning…"
						value={purpose}
						maxLength={4000}
						disabled={saving}
						onChange={(event) => setPurpose(event.target.value)}
						rows={3}
					/>
				</div>
				<PalModelField
					value={model}
					onChange={setModel}
					disabled={saving}
					loadProviders={loadProviders}
					loadModels={loadModels}
				/>
				<div className="pal-computer-note">
					<MonitorIcon aria-hidden="true" />
					<p>
						Each Pal gets a private local computer. Its setup and connection status will appear in
						the conversation.
					</p>
				</div>
				{(error || submitError) && (
					<p className="pal-error" role="alert">
						{error || submitError}
					</p>
				)}
				<footer className="pal-editor-actions">
					<Button variant="ghost-muted" disabled={saving} onClick={onCancelEdit}>
						Cancel
					</Button>
					<Button type="submit" disabled={saving || !name.trim() || Boolean(model && !model.model)}>
						{saving && <LoaderCircleIcon className="pal-loading" />}
						{saving ? 'Saving…' : editing ? 'Save changes' : 'Create Pal'}
					</Button>
				</footer>
			</form>
		</div>
	)
}

export function PalsPage(props: PalsPageProps) {
	const { pals, loading, saving, error, creating, editing, onStartCreate, onOpen, onEdit } = props
	return (
		<section id="pals-content" className="pals-page" aria-label="Pals" tabIndex={-1}>
			<div className="pals-page-content">
				<header className="pals-page-heading">
					<div>
						<h1>Your Pals</h1>
						<p>A familiar place for each Pal and their work.</p>
					</div>
					{!creating && !editing && (
						<Button variant="outline" onClick={onStartCreate} disabled={loading || saving}>
							<PlusIcon />
							New Pal
						</Button>
					)}
				</header>
				{creating || editing ? (
					<PalEditor key={editing ? `${editing.id}:${editing.revision}` : 'new'} {...props} />
				) : loading ? (
					<output className="pal-feedback">
						<LoaderCircleIcon className="pal-loading" />
						Loading your Pals…
					</output>
				) : (
					<>
						{error && (
							<p className="pal-error" role="alert">
								{error}
							</p>
						)}
						{pals.length === 0 ? (
							<div className="pals-empty">
								<PalAvatar name="Pal" />
								<h2>Hi! I'm your Pal.</h2>
								<p>
									Give me a name and tell me what you'd like help with. We can get my local computer
									ready together.
								</p>
								<Button onClick={onStartCreate}>
									<UserRoundIcon />
									Create your first Pal
								</Button>
							</div>
						) : (
							<div className="pals-list">
								{pals.map((pal) => (
									<article className="pal-list-card" key={pal.id}>
										<button
											type="button"
											className="pal-list-open"
											onClick={() => onOpen(pal)}
											disabled={saving}
										>
											<PalAvatar name={pal.name} />
											<span className="pal-list-copy">
												<strong>{pal.name}</strong>
												<span>{pal.purpose || 'Ready for a new conversation'}</span>
											</span>
											<ChevronRightIcon className="pal-list-chevron" />
										</button>
										<Button
											variant="ghost-muted"
											size="icon"
											aria-label={`Customize ${pal.name}`}
											onClick={() => onEdit(pal)}
											disabled={saving}
										>
											<SettingsIcon />
										</Button>
									</article>
								))}
							</div>
						)}
					</>
				)}
			</div>
		</section>
	)
}

export function PalSidebarSection({
	pals,
	selectedId,
	loading,
	onCreate,
	onOpen,
}: {
	pals: readonly PalView[]
	selectedId?: string
	loading: boolean
	onCreate: () => void
	onOpen: (pal: PalView) => void
}) {
	return (
		<section className="sidebar-pals" aria-label="Pals">
			<header>
				<h2>Pals</h2>
				<Button
					variant="ghost-muted"
					size="icon-xs"
					aria-label="Create Pal"
					onClick={onCreate}
					disabled={loading}
				>
					<PlusIcon />
				</Button>
			</header>
			{loading ? (
				<output className="sidebar-pals-loading">Loading…</output>
			) : (
				pals.map((pal) => (
					<Button
						key={pal.id}
						variant="ghost"
						className="sidebar-pal-row"
						aria-current={selectedId === pal.id ? 'page' : undefined}
						onClick={() => onOpen(pal)}
					>
						<PalAvatar name={pal.name} compact />
						<span>{pal.name}</span>
						{pal.paused && <small>Paused</small>}
					</Button>
				))
			)}
			{!loading && pals.length === 0 && (
				<Button variant="ghost-muted" className="sidebar-pal-row" onClick={onCreate}>
					<UserRoundIcon />
					<span>Create your first Pal</span>
				</Button>
			)}
		</section>
	)
}

export function PalWelcome({
	pal,
	onCustomize,
	disabled = false,
}: { pal: PalView; onCustomize: () => void; disabled?: boolean }) {
	return (
		<div className="pal-welcome">
			<div className="pal-welcome-message">Hi! I'm {pal.name}.</div>
			<div className="pal-welcome-message">
				{pal.purpose ||
					"Tell me what you'd like to work on. We can pick up our conversations here."}
			</div>
			<Button
				className="pal-welcome-customize"
				variant="ghost"
				disabled={disabled}
				onClick={onCustomize}
			>
				<UserRoundIcon />
				Customize your Pal
				<ChevronRightIcon />
			</Button>
		</div>
	)
}
