import { Dialog } from '@base-ui/react/dialog'
import { useEffect, useId, useRef, useState } from 'react'
import { duplicatePalNameMessage, isDuplicatePalName } from '../shared/pal-name.js'
import type {
	ModelCatalogueView,
	PalCreateInput,
	PalView,
	ProviderView,
} from '../shared/protocol.js'
import {
	ChevronRightIcon,
	LoaderCircleIcon,
	PlusIcon,
	TrashIcon,
	UserRoundIcon,
	XIcon,
} from './icons.js'
import { pickOfferedPalModel } from './model-choice.js'
import { ModelPicker } from './model-picker.js'
import { PalCharacter3D } from './pal-character-3d.js'
import {
	PalCharacter,
	type PalCharacterAppearance,
	defaultPalAppearance,
	palCharacters,
	palColors,
} from './pal-character.js'
import { PalAvatar } from './pal-context.js'
import { palsAttention } from './sidebar-section-attention.js'
import { SidebarSection } from './sidebar-section.js'
import { createSubmitGuard } from './submit-guard.js'
import { Button } from './ui/button.js'
import { Input } from './ui/input.js'
import './pals-page.css'

type ModelLoaders = {
	loadProviders: () => Promise<ProviderView>
	loadModels: (provider: string) => Promise<ModelCatalogueView>
}

function PalModelChoice({
	value,
	onChange,
	disabled,
	loadProviders,
	loadModels,
	positionerClassName,
	fillDefault = false,
	preferred,
}: ModelLoaders & {
	value: PalView['model']
	onChange: (value: PalView['model']) => void
	disabled: boolean
	positionerClassName?: string
	/** A new Pal: start from a model a connected provider lists, instead of the configured literal. */
	fillDefault?: boolean
	/** The composer's current choice, tried first. */
	preferred?: { provider: string; model: string }
}) {
	const [providers, setProviders] = useState<ProviderView>()
	const [labels, setLabels] = useState<Record<string, string>>({})
	const [error, setError] = useState('')
	const [retry, setRetry] = useState(0)
	useEffect(() => {
		let active = true
		setError('')
		void loadProviders().then(
			(result) => {
				if (active) setProviders(result)
			},
			() => {
				if (active)
					setError(
						`${retry > 0 ? 'Still could not' : 'Could not'} load models. You can save your Pal and choose one later.`,
					)
			},
		)
		return () => {
			active = false
		}
	}, [loadProviders, retry])
	const configured = providers?.selected
	const preferredKey = preferred ? `${preferred.provider}\n${preferred.model}` : ''
	useEffect(() => {
		if (!fillDefault || value || !providers || providers.available.length === 0) return
		let active = true
		// The composer's choice arrives as a key, so a new object each render never restarts the read.
		const [preferredProvider, preferredModel] = preferredKey.split('\n')
		void pickOfferedPalModel({
			candidates: [
				...(preferredProvider && preferredModel
					? [{ provider: preferredProvider, model: preferredModel }]
					: []),
				...(providers.selected
					? [{ provider: providers.selected.id, model: providers.selected.model }]
					: []),
				...providers.available.map((entry) => ({ provider: entry.id })),
			],
			providers,
			loadModels,
		}).then((picked) => {
			if (!active || !picked) return
			if (picked.label)
				setLabels((all) => ({
					...all,
					[`${picked.provider}:${picked.model}`]: picked.label as string,
				}))
			onChange({ provider: picked.provider, model: picked.model })
		})
		return () => {
			active = false
		}
	}, [fillDefault, providers, value, loadModels, onChange, preferredKey])
	const route = value ?? {
		provider: configured?.id ?? '',
		model: configured?.model ?? '',
	}
	const choice = {
		...route,
		label: labels[`${route.provider}:${route.model}`],
	}
	return (
		<div className="pal-model-choice">
			{providers && providers.available.length > 0 ? (
				<ModelPicker
					providers={providers}
					choice={choice}
					disabled={disabled}
					onChange={(next) => {
						if (next.label)
							setLabels((all) => ({
								...all,
								[`${next.provider}:${next.model}`]: next.label ?? next.model,
							}))
						onChange({ provider: next.provider, model: next.model })
					}}
					projectId="pal-profile"
					positionerClassName={positionerClassName}
					loadCatalogue={loadModels}
				/>
			) : (
				<span className="pal-model-placeholder">
					{providers ? 'Choose a model later' : error ? 'Choose a model later' : 'Loading models…'}
				</span>
			)}
			{value && (
				<Button variant="ghost-muted" size="xs" disabled={disabled} onClick={() => onChange(null)}>
					Use default
				</Button>
			)}
			{error && (
				<div className="pal-model-error" role="alert">
					<span>{error}</span>
					<Button
						variant="ghost-muted"
						size="xs"
						onClick={() => setRetry((current) => current + 1)}
					>
						Retry
					</Button>
				</div>
			)}
		</div>
	)
}

/** The name a person typed, compared the way they would read it: case and edge spaces do not count. */
export function nameKey(value: string): string {
	return value.trim().toLocaleLowerCase()
}

/** What to tell the person about the name they are typing; nothing when there is nothing to say. */
export function palNameHint(
	name: string,
	existing: readonly string[],
	attempted: boolean,
): { tone: 'empty' | 'duplicate'; text: string } | undefined {
	const key = nameKey(name)
	if (!key)
		return {
			tone: 'empty',
			text: attempted ? 'Give your Pal a name to save it.' : 'Give your Pal a name.',
		}
	// A duplicate is refused on save, so the dialog says the refusal once, in the words Save gives.
	if (isDuplicatePalName(name, existing))
		return { tone: 'duplicate', text: duplicatePalNameMessage(name, existing) }
	return undefined
}

export function PalCustomizeDialog({
	editing,
	existingNames = [],
	saving,
	error,
	model,
	onModelChange,
	onClose,
	onSave,
	onDelete,
	loadProviders,
	loadModels,
	preferredModel,
}: ModelLoaders & {
	/** The composer's current model, which a new Pal starts from when a provider lists it. */
	preferredModel?: { provider: string; model: string }
	editing?: PalView
	/** Names of the person's other Pals, to warn about a duplicate. */
	existingNames?: readonly string[]
	saving: boolean
	error?: string
	model: PalView['model']
	onModelChange: (model: PalView['model']) => void
	onClose: () => void
	onSave: (input: PalCreateInput, id?: string) => Promise<void>
	onDelete?: (pal: PalView) => void
}) {
	const id = useId()
	// One id per dialog: a second submit of the same attempt is the same create, never a new Pal.
	const attempt = useRef(globalThis.crypto.randomUUID())
	// A ref, not the prop: two submits can arrive before the next render says "saving".
	const submitting = useRef(createSubmitGuard())
	const [name, setName] = useState(editing?.name ?? '')
	const [appearance, setAppearance] = useState<PalCharacterAppearance>(
		editing?.appearance ?? defaultPalAppearance,
	)
	const [attempted, setAttempted] = useState(false)
	const named = palNameHint(name, existingNames, attempted)
	// Once Save has answered with the same refusal, only that answer is shown.
	const hint = error && named?.tone === 'duplicate' ? undefined : named
	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open && !saving) onClose()
			}}
			disablePointerDismissal={saving}
		>
			<Dialog.Portal>
				<Dialog.Backdrop className="pal-customize-backdrop" />
				<Dialog.Viewport className="pal-customize-viewport">
					<Dialog.Popup
						className="pal-customize-popup"
						initialFocus={() => document.getElementById(`${id}-name`)}
					>
						<form
							className="pal-customize-form"
							onSubmit={(event) => {
								event.preventDefault()
								if (saving) return
								if (!name.trim()) {
									setAttempted(true)
									document.getElementById(`${id}-name`)?.focus()
									return
								}
								const input: PalCreateInput = { name: name.trim(), model, appearance }
								if (!editing) input.requestId = attempt.current
								submitting.current.run(() => onSave(input, editing?.id))
							}}
						>
							<div className="pal-customize-mobile-heading" aria-hidden="true">
								Customize your Pal
							</div>
							<div className="pal-customize-controls">
								<header>
									<Dialog.Title>Customize your Pal</Dialog.Title>
									<Dialog.Description>Make a little character of your own.</Dialog.Description>
								</header>
								<fieldset className="pal-color-options">
									<legend>Colors</legend>
									<div className="pal-choice-row">
										{palColors.map((color) => (
											<label
												className="pal-color-choice"
												key={color.id}
												style={{ '--pal-swatch': color.base } as React.CSSProperties}
											>
												<input
													type="radio"
													name={`${id}-color`}
													value={color.id}
													checked={appearance.color === color.id}
													disabled={saving}
													onChange={() =>
														setAppearance((current) => ({
															...current,
															color: color.id,
														}))
													}
												/>
												<span aria-hidden="true" />
												<span className="sr-only">{color.label}</span>
											</label>
										))}
									</div>
								</fieldset>
								<fieldset className="pal-character-options">
									<legend>Characters</legend>
									<div className="pal-choice-row">
										{palCharacters.map((character) => (
											<label className="pal-character-choice-option" key={character.id}>
												<input
													type="radio"
													name={`${id}-character`}
													value={character.id}
													checked={appearance.character === character.id}
													disabled={saving}
													onChange={() =>
														setAppearance((current) => ({
															...current,
															character: character.id,
														}))
													}
												/>
												<PalCharacter
													appearance={{
														...appearance,
														character: character.id,
													}}
													size="choice"
												/>
												<span>{character.label}</span>
											</label>
										))}
									</div>
								</fieldset>
								{editing && (
									<div className="pal-customize-model">
										<span className="pal-field-label">Default model</span>
										<PalModelChoice
											value={model}
											onChange={onModelChange}
											disabled={saving}
											loadProviders={loadProviders}
											loadModels={loadModels}
											positionerClassName="pal-customize-model-positioner"
											fillDefault={!editing}
											preferred={preferredModel}
										/>
										<p>For new conversations.</p>
									</div>
								)}
								{error && (
									<p className="pal-error" role="alert">
										{error}
									</p>
								)}
								{editing && onDelete && (
									<Button
										variant="ghost-destructive"
										size="sm"
										disabled={saving}
										onClick={() => onDelete(editing)}
									>
										<TrashIcon /> Delete {editing.name}
									</Button>
								)}
							</div>
							<div className="pal-customize-preview">
								<Dialog.Close
									render={
										<Button
											variant="ghost-muted"
											size="icon-sm"
											className="pal-customize-close"
											disabled={saving}
										/>
									}
									aria-label="Close customization"
								>
									<XIcon />
								</Dialog.Close>
								<label className="sr-only" htmlFor={`${id}-name`}>
									Pal name
								</label>
								<Input
									nativeInput
									unstyled
									className="pal-name-preview"
									id={`${id}-name`}
									placeholder="Your Pal’s name"
									value={name}
									maxLength={80}
									disabled={saving}
									autoComplete="off"
									aria-describedby={hint ? `${id}-hint` : undefined}
									aria-invalid={hint?.tone === 'empty' && attempted ? true : undefined}
									onChange={(event) => setName(event.target.value)}
									onKeyDown={(event) => {
										// Enter cannot submit while Save is off, so it says why instead of doing nothing.
										if (event.key === 'Enter' && !event.nativeEvent.isComposing && !name.trim())
											setAttempted(true)
									}}
								/>
								{hint && (
									<p
										id={`${id}-hint`}
										className="pal-name-hint"
										data-tone={hint.tone}
										role={hint.tone === 'empty' && attempted ? 'alert' : 'status'}
									>
										{hint.text}
									</p>
								)}
								<div className="pal-customize-character" key={appearance.character}>
									<PalCharacter3D appearance={appearance} />
								</div>
								<footer className="pal-customize-actions">
									<Button
										type="submit"
										className="pal-customize-save"
										disabled={saving || !name.trim()}
									>
										{saving && <LoaderCircleIcon className="pal-loading" />}
										{saving ? 'Saving…' : 'Save'}
									</Button>
								</footer>
							</div>
						</form>
					</Dialog.Popup>
				</Dialog.Viewport>
			</Dialog.Portal>
		</Dialog.Root>
	)
}

/** What the opening notice says after this many seconds. Pure so it is tested without a clock. */
export function palOpeningStatus(
	name: string,
	seconds: number,
): { text: string; stalled: boolean } {
	if (seconds >= PAL_OPENING_STALLED_SECONDS)
		return { text: `Still starting ${name}… ${seconds}s`, stalled: true }
	if (seconds >= 2) return { text: `Opening ${name}… ${seconds}s`, stalled: false }
	return { text: `Opening ${name}…`, stalled: false }
}
export const PAL_OPENING_STALLED_SECONDS = 10

export type PalOpening = { palId: string; name: string; startedAt: number; failure?: string }

/** Shows a Pal that is created and still starting, or that could not start. Never blocks anything. */
export function PalOpeningNotice({
	opening,
	onRetry,
	onCancel,
}: {
	opening: PalOpening
	onRetry: () => void
	onCancel: () => void
}) {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (opening.failure) return
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [opening.failure])
	if (opening.failure)
		return (
			<div className="pal-opening" role="alert" data-state="failed">
				<span>
					{opening.name} is created, but it could not start. {opening.failure}
				</span>
				<Button variant="outline" size="xs" onClick={onRetry}>
					Retry
				</Button>
				<Button variant="ghost-muted" size="xs" onClick={onCancel}>
					Dismiss
				</Button>
			</div>
		)
	const status = palOpeningStatus(
		opening.name,
		Math.max(0, Math.floor((now - opening.startedAt) / 1000)),
	)
	return (
		<output className="pal-opening" data-state={status.stalled ? 'stalled' : 'opening'}>
			<LoaderCircleIcon className="pal-loading" />
			<span>{status.text}</span>
			<Button variant="ghost-muted" size="xs" onClick={onCancel}>
				Cancel
			</Button>
		</output>
	)
}

export function PalsPage({
	model,
	onModelChange,
	onCustomize,
	opening,
	onRetryOpening,
	onCancelOpening,
	loadProviders,
	loadModels,
	preferredModel,
}: ModelLoaders & {
	preferredModel?: { provider: string; model: string }
	model: PalView['model']
	onModelChange: (model: PalView['model']) => void
	onCustomize: () => void
	opening?: PalOpening
	onRetryOpening: () => void
	onCancelOpening: () => void
}) {
	return (
		<section
			id="pals-content"
			className="pals-page pal-onboarding"
			aria-label="Meet your Pal"
			tabIndex={-1}
		>
			<header className="pal-onboarding-header">
				<span>Meet your Pal</span>
			</header>
			<div className="pal-onboarding-transcript">
				<div className="conversation-body">
					<PalWelcome />
					<div className="pal-onboarding-model">
						<span>Which model would you like me to use?</span>
						<PalModelChoice
							value={model}
							onChange={onModelChange}
							disabled={false}
							loadProviders={loadProviders}
							loadModels={loadModels}
							fillDefault
							preferred={preferredModel}
						/>
					</div>
				</div>
			</div>
			{opening && (
				<PalOpeningNotice opening={opening} onRetry={onRetryOpening} onCancel={onCancelOpening} />
			)}
			<footer className="pal-onboarding-footer">
				<p>Give your Pal a name to start.</p>
				<Button variant="outline" onClick={onCustomize}>
					<UserRoundIcon />
					Customize your Pal
					<ChevronRightIcon />
				</Button>
			</footer>
		</section>
	)
}

/** The most Pals the sidebar lists without a group heading. */
export const PAL_GROUP_AFTER = 3

export function PalSidebarSection({
	pals,
	selectedId,
	unreadIds,
	markers,
	creating,
	openingId,
	loading,
	failed,
	onRetry,
	onCreate,
	onOpen,
	collapsed,
	onCollapsedChange,
}: {
	pals: readonly PalView[]
	selectedId?: string
	/** Pals the person has messaged and not opened since. */
	unreadIds?: ReadonlySet<string>
	/** What each marker says; a Pal without an entry reads as a message that is waiting. */
	markers?: ReadonlyMap<string, { state: 'waiting' | 'reading' | 'failed'; label: string }>
	creating?: boolean
	openingId?: string
	loading: boolean
	/** The Pal list could not be read: say so with a Retry instead of offering to create a first Pal. */
	failed?: boolean
	onRetry?: () => void
	onCreate: () => void
	onOpen: (pal: PalView) => void
	/** Whether the section is folded; absent keeps the state inside the component. */
	collapsed?: boolean
	onCollapsedChange?: (collapsed: boolean) => void
}) {
	const rows = (
		<>
			{pals.map((pal) => (
				<Button
					key={pal.id}
					variant="ghost"
					className="sidebar-pal-row"
					aria-current={!creating && selectedId === pal.id ? 'page' : undefined}
					onClick={() => onOpen(pal)}
				>
					<PalAvatar name={pal.name} appearance={pal.appearance} compact paused={pal.paused} />
					<span>{pal.name}</span>
					{pal.paused && <small>Paused</small>}
					{openingId === pal.id && <small>Opening…</small>}
					{unreadIds?.has(pal.id) && selectedId !== pal.id && (
						<i
							className="sidebar-pal-unread"
							data-state={markers?.get(pal.id)?.state ?? 'waiting'}
							title={markers?.get(pal.id)?.label ?? 'New message'}
						>
							<span className="sr-only">{markers?.get(pal.id)?.label ?? 'New message'}</span>
						</i>
					)}
				</Button>
			))}
			<Button
				variant="ghost-muted"
				className="sidebar-pal-row sidebar-pal-create"
				aria-current={creating ? 'page' : undefined}
				onClick={onCreate}
				disabled={loading}
			>
				{pals.length === 0 ? <PalCharacter size="compact" /> : <PlusIcon />}
				<span>{pals.length === 0 ? 'Create your first Pal' : 'New Pal'}</span>
			</Button>
		</>
	)
	const body = loading ? (
		<output className="sidebar-pals-loading" aria-label="Loading Pals">
			<span className="sidebar-section-skeleton" />
		</output>
	) : failed && pals.length === 0 ? (
		<div className="sidebar-pals-failed" role="alert">
			<span>Couldn’t load your Pals.</span>
			<Button variant="ghost-muted" size="sm" onClick={onRetry}>
				Retry
			</Button>
		</div>
	) : (
		rows
	)
	// Up to PAL_GROUP_AFTER Pals there is no group: the rows sit directly under "New conversation".
	// Only a longer list earns a foldable "Pals" heading, which remembers its state.
	if (loading || pals.length <= PAL_GROUP_AFTER)
		return (
			<section className="sidebar-pals" aria-label="Pals">
				{body}
			</section>
		)
	return (
		<SidebarSection
			label="Pals"
			className="sidebar-pals"
			titleClassName="sidebar-pals-heading"
			collapsed={collapsed}
			onCollapsedChange={onCollapsedChange}
			attention={palsAttention(
				pals.map((pal) => pal.id),
				unreadIds,
				selectedId,
			)}
		>
			{body}
		</SidebarSection>
	)
}

/** The greeting only. Naming and customizing the Pal is the page's one action below it. */
export function PalWelcome({ pal }: { pal?: PalView }) {
	return (
		<div className="pal-welcome">
			{!pal && (
				<div className="pal-welcome-identity">
					<PalCharacter3D />
				</div>
			)}
			<div className="pal-welcome-message">
				{pal ? `Hey! I’m ${pal.name}.` : 'Hey! I’m your Pal.'}
			</div>
			<div className="pal-welcome-message">
				{pal?.purpose ||
					'Bring me an idea, a question, or something you’d like to work on. We can pick it up together here.'}
			</div>
			{!pal && <div className="pal-welcome-message">What would you like to call me?</div>}
		</div>
	)
}
