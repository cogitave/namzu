import { Dialog } from '@base-ui/react/dialog'
import { useEffect, useId, useState } from 'react'
import type { ModelCatalogueView, PalInput, PalView, ProviderView } from '../shared/protocol.js'
import {
	ChevronDownIcon,
	ChevronRightIcon,
	LoaderCircleIcon,
	PlusIcon,
	TrashIcon,
	UserRoundIcon,
	XIcon,
} from './icons.js'
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
import { Button } from './ui/button.js'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from './ui/collapsible.js'
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
}: ModelLoaders & {
	value: PalView['model']
	onChange: (value: PalView['model']) => void
	disabled: boolean
	positionerClassName?: string
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
	if (existing.some((other) => nameKey(other) === key))
		return {
			tone: 'duplicate',
			text: `You already have a Pal called “${name.trim()}”. You can keep this name, but messages and tabs for the two will look alike.`,
		}
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
}: ModelLoaders & {
	editing?: PalView
	/** Names of the person's other Pals, to warn about a duplicate. */
	existingNames?: readonly string[]
	saving: boolean
	error?: string
	model: PalView['model']
	onModelChange: (model: PalView['model']) => void
	onClose: () => void
	onSave: (input: PalInput, id?: string) => Promise<void>
	onDelete?: (pal: PalView) => void
}) {
	const id = useId()
	const [name, setName] = useState(editing?.name ?? '')
	const [appearance, setAppearance] = useState<PalCharacterAppearance>(
		editing?.appearance ?? defaultPalAppearance,
	)
	const [attempted, setAttempted] = useState(false)
	const hint = palNameHint(name, existingNames, attempted)
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
								void onSave({ name: name.trim(), model, appearance }, editing?.id)
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

export function PalsPage({
	model,
	onModelChange,
	onCustomize,
	loadProviders,
	loadModels,
}: ModelLoaders & {
	model: PalView['model']
	onModelChange: (model: PalView['model']) => void
	onCustomize: () => void
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
						/>
					</div>
				</div>
			</div>
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

export function PalSidebarSection({
	pals,
	selectedId,
	creating,
	loading,
	onCreate,
	onOpen,
}: {
	pals: readonly PalView[]
	selectedId?: string
	creating?: boolean
	loading: boolean
	onCreate: () => void
	onOpen: (pal: PalView) => void
}) {
	const [expanded, setExpanded] = useState(true)
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
	return (
		<section className="sidebar-pals" aria-label="Pals">
			{pals.length <= 3 && <h2 className="sidebar-pals-heading">Pals</h2>}
			{loading ? (
				<output className="sidebar-pals-loading">Loading…</output>
			) : pals.length > 3 ? (
				<Collapsible open={expanded} onOpenChange={setExpanded}>
					<CollapsibleTrigger
						render={<Button variant="ghost-muted" className="sidebar-pals-group" />}
					>
						<span>Pals</span>
						<ChevronDownIcon />
					</CollapsibleTrigger>
					<CollapsiblePanel>{rows}</CollapsiblePanel>
				</Collapsible>
			) : (
				rows
			)}
		</section>
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
