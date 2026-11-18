import { useCallback, useEffect, useId, useState } from 'react'
import type { InstalledSkillsView } from '../shared/config-lists-protocol.js'
import {
	addFolder,
	missingFolders,
	skillSwitchRows,
	skillsDisabledValue,
	withoutItem,
} from '../shared/config-lists-values.js'
import type {
	ConfigSettingControl,
	ConfigSettingDescriptor,
	ConfigSettingOption,
} from '../shared/config-settings-protocol.js'
import {
	DEFAULTS_ENTRY,
	type RoutingForm,
	SMALL_MODEL_WORD,
	autoEntryLabel,
	autoModeList,
	autoModeModel,
	autoModeSet,
	eventSwitchTicked,
	eventSwitchValue,
	levelsHeld,
	levelsValue,
	routingForm,
	routingValue,
	sameSet,
	screenNames,
	screenTools,
	screensValue,
} from '../shared/config-settings-values.js'
import { Switch } from './settings-row.js'
import { Button } from './ui/button.js'
import type { ConfigSettingsControls, ModelChoiceGroup } from './use-config-settings.js'

type Of<K extends ConfigSettingControl['kind']> = Extract<ConfigSettingControl, { kind: K }>

/** One checkbox per option, the option's help on a line under its label. */
function OptionChecks({
	legend,
	options,
	ticked,
	disabled,
	onChange,
	scroll,
}: {
	legend: string
	options: readonly ConfigSettingOption[]
	ticked: readonly string[]
	disabled?: boolean
	onChange: (next: string[]) => void
	scroll?: boolean
}) {
	return (
		<fieldset
			className="settings-choices settings-choices-inline settings-config-checks"
			data-scroll={scroll || undefined}
		>
			<legend className="sr-only">{legend}</legend>
			{options.map((option) => (
				<label key={option.value} className="settings-choice">
					<input
						type="checkbox"
						checked={ticked.includes(option.value)}
						disabled={disabled}
						onChange={(event) =>
							onChange(
								event.target.checked
									? [...ticked, option.value]
									: ticked.filter((item) => item !== option.value),
							)
						}
					/>
					<span className="settings-choice-label">
						{option.label}
						{option.help && <span className="settings-config-help">{option.help}</span>}
					</span>
				</label>
			))}
		</fieldset>
	)
}

/**
 * The events, one check each. None ticked is off, so the row needs no switch of its own: a switch
 * would sit under the description, apart from every other switch on the page.
 */
export function EventSwitch({
	descriptor,
	control,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	control: Of<'toggle-checks'>
	value: unknown
	config: ConfigSettingsControls
}) {
	const ticked = eventSwitchTicked(value, control)
	return (
		<div className="settings-config-list">
			<OptionChecks
				legend={descriptor.label}
				options={control.options}
				ticked={ticked}
				onChange={(next) => void config.change(descriptor.path, eventSwitchValue(next, control))}
			/>
		</div>
	)
}

/** A switch that saves one of two fixed lists. */
export function ListSwitch({
	descriptor,
	control,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	control: Of<'toggle-list'>
	value: unknown
	config: ConfigSettingsControls
}) {
	return (
		<Switch
			label={descriptor.label}
			checked={sameSet(value, control.on)}
			onChange={(on) =>
				void config.change(descriptor.path, on ? [...control.on] : [...control.off])
			}
		/>
	)
}

const OFFERED_NOT = '\u0000not-offered'

/** One key of a closed list, with the default as the first choice. */
export function KeyPicker({
	descriptor,
	control,
	value,
	set,
	defaultText,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	control: Of<'key'>
	value: unknown
	set: boolean
	defaultText: string | undefined
	config: ConfigSettingsControls
}) {
	// A saved `Ctrl+B` or `ctrl + b` is the same key as `ctrl+b`.
	const saved = typeof value === 'string' ? value.trim().toLowerCase().replaceAll(' ', '') : ''
	const known = control.options.some((option) => option.value === saved)
	return (
		<select
			className="settings-config-input"
			aria-label={descriptor.label}
			value={set && known ? saved : set && saved !== '' ? OFFERED_NOT : ''}
			onChange={(event) =>
				void config.change(
					descriptor.path,
					event.target.value === '' ? undefined : event.target.value,
				)
			}
		>
			<option value="">{defaultText ? `Default (${defaultText})` : 'Default'}</option>
			{set && !known && saved !== '' && (
				<option value={OFFERED_NOT} disabled>
					{`${saved} (saved, not offered here)`}
				</option>
			)}
			{control.options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	)
}

/** A choice of level for each entry; an entry at its default leaves the file. */
export function LevelsEditor({
	descriptor,
	control,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	control: Of<'levels'>
	value: unknown
	config: ConfigSettingsControls
}) {
	const held = levelsHeld(value, descriptor.default)
	const defaults = (
		typeof descriptor.default === 'object' && !Array.isArray(descriptor.default)
			? descriptor.default
			: {}
	) as Record<string, string>
	return (
		<ul className="settings-config-levels">
			{control.entries.map((entry) => (
				<li key={entry.value}>
					<span className="settings-config-level-name">
						{entry.label}
						{entry.help && <span className="settings-config-help">{entry.help}</span>}
					</span>
					<select
						className="settings-config-input"
						aria-label={entry.label}
						value={held[entry.value] ?? ''}
						onChange={(event) => {
							const next = levelsValue(
								{ ...held, [entry.value]: event.target.value },
								descriptor.default,
							)
							void (next === undefined
								? config.change(descriptor.path)
								: config.change(descriptor.path, next))
						}}
					>
						{control.levels.map((level) => (
							<option key={level.value} value={level.value}>
								{level.label}
								{defaults[entry.value] === level.value ? ' (default)' : ''}
							</option>
						))}
					</select>
				</li>
			))}
		</ul>
	)
}

/** Words typed one per entry, each with Remove. */
export function ListEditor({
	label,
	itemLabel,
	placeholder,
	items,
	disabled,
	itemText,
	onChange,
	onPending,
}: {
	label: string
	itemLabel: string
	placeholder?: string
	items: readonly string[]
	disabled?: boolean
	/** How an entry reads in the list, when that is not the entry as written. */
	itemText?: (item: string) => string
	onChange: (next: string[]) => Promise<boolean | undefined> | undefined
	/** Told what is typed and not yet added, so a form can ask for it to be added or cleared. */
	onPending?: (text: string) => void
}) {
	const [draft, setDraftText] = useState('')
	const setDraft = (text: string) => {
		setDraftText(text)
		onPending?.(text)
	}
	const add = async () => {
		const word = draft.trim()
		if (word === '') return
		if (items.includes(word)) return setDraft('')
		if ((await onChange([...items, word])) !== false) setDraft('')
	}
	return (
		<div className="settings-config-list">
			{items.length > 0 && (
				<ul className="settings-config-items" aria-label={label}>
					{items.map((item) => (
						<li key={item}>
							<span className="settings-config-item">{itemText ? itemText(item) : item}</span>
							<Button
								variant="ghost-muted"
								size="xs"
								disabled={disabled}
								aria-label={`Remove ${itemText ? itemText(item) : item}`}
								onClick={() => void onChange(items.filter((other) => other !== item))}
							>
								Remove
							</Button>
						</li>
					))}
				</ul>
			)}
			<span className="settings-config-field">
				<input
					type="text"
					className="settings-config-input settings-config-wide"
					aria-label={`Add ${itemLabel}`}
					value={draft}
					placeholder={placeholder ?? ''}
					disabled={disabled}
					spellCheck={false}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							// Inside a form, Enter adds the entry; it must not also submit the form.
							event.preventDefault()
							void add()
						}
					}}
				/>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled || draft.trim() === ''}
					onClick={() => void add()}
				>
					Add
				</Button>
			</span>
		</div>
	)
}

/** Folders, one per line with Remove; a folder that is not there is flagged. */
export function FolderListView({
	label,
	items,
	missing,
	canPick,
	disabled,
	onAdd,
	onRemove,
}: {
	label: string
	items: readonly string[]
	missing: ReadonlySet<string>
	canPick: boolean
	disabled?: boolean
	onAdd: () => void
	onRemove: (item: string) => void
}) {
	return (
		<div className="settings-config-list">
			{items.length > 0 && (
				<ul className="settings-config-items" aria-label={label}>
					{items.map((item) => (
						<li key={item} data-missing={missing.has(item) || undefined}>
							<span className="settings-config-item">
								{item}
								{missing.has(item) && (
									<span className="settings-config-flag">This folder was not found.</span>
								)}
							</span>
							<Button
								variant="ghost-muted"
								size="xs"
								disabled={disabled}
								aria-label={`Remove ${item}`}
								onClick={() => onRemove(item)}
							>
								Remove
							</Button>
						</li>
					))}
				</ul>
			)}
			{items.length === 0 && <p className="settings-note">No extra folders.</p>}
			{canPick && (
				<span className="settings-config-field">
					<Button variant="outline" size="sm" disabled={disabled} onClick={onAdd}>
						Add folder
					</Button>
				</span>
			)}
		</div>
	)
}

/** The extra folders, added through the system folder picker. */
export function FolderList({
	descriptor,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	value: unknown
	config: ConfigSettingsControls
}) {
	const items = Array.isArray(value) ? (value as string[]) : []
	const pick = config.tools?.pickFolder
	const check = config.tools?.existingFolders
	const [found, setFound] = useState<string[]>()
	const [pickError, setPickError] = useState('')
	const key = JSON.stringify(items)
	// biome-ignore lint/correctness/useExhaustiveDependencies: the list is read through its key
	useEffect(() => {
		if (!check || items.length === 0) return setFound(undefined)
		let current = true
		check(items).then(
			(answer) => current && setFound(answer),
			() => current && setFound(undefined),
		)
		return () => {
			current = false
		}
	}, [check, key])
	return (
		<>
			<FolderListView
				label={descriptor.label}
				items={items}
				missing={missingFolders(items, found)}
				canPick={pick !== undefined}
				onAdd={() => {
					if (!pick) return
					setPickError('')
					pick().then(
						(picked) => {
							if (picked) void config.change(descriptor.path, addFolder(items, picked))
						},
						() => setPickError('The folder picker did not open.'),
					)
				}}
				onRemove={(item) => {
					const next = withoutItem(items, item)
					void (next.length === 0
						? config.change(descriptor.path)
						: config.change(descriptor.path, next))
				}}
			/>
			{pickError && (
				<p role="alert" className="settings-error settings-config-error">
					{pickError}
				</p>
			)}
		</>
	)
}

/** The installed skills with a switch each, and the names in the file that no skill has. */
export function SkillSwitchesView({
	label,
	rows,
	onSwitch,
	onRemoveUnknown,
}: {
	label: string
	rows: ReturnType<typeof skillSwitchRows>
	onSwitch: (name: string, on: boolean) => void
	onRemoveUnknown: (name: string) => void
}) {
	return (
		<div className="settings-config-list">
			{rows.installed.length === 0 && rows.unknown.length === 0 && (
				<p className="settings-note">No skills are installed.</p>
			)}
			<ul className="settings-config-items" aria-label={label}>
				{rows.installed.map((skill) => (
					<li key={skill.name} data-off={!skill.on || undefined}>
						<span className="settings-config-item settings-config-name">
							{skill.name}
							<span className="settings-config-help">
								{skill.on ? skill.where : `${skill.where} · Off`}
							</span>
						</span>
						<Switch
							label={`Use ${skill.name}`}
							checked={skill.on}
							onChange={(on) => onSwitch(skill.name, on)}
						/>
					</li>
				))}
				{rows.unknown.map((name) => (
					<li key={`unknown:${name}`} data-off>
						<span className="settings-config-item settings-config-name">
							{name}
							<span className="settings-config-help">Off. No installed skill has this name.</span>
						</span>
						<Button
							variant="ghost-muted"
							size="xs"
							aria-label={`Remove ${name}`}
							onClick={() => onRemoveUnknown(name)}
						>
							Remove
						</Button>
					</li>
				))}
			</ul>
		</div>
	)
}

/** Reads the installed skills once per page and per project; null while unread or unavailable. */
function useInstalledSkills(config: ConfigSettingsControls) {
	const read = config.tools?.installedSkills
	const [skills, setSkills] = useState<InstalledSkillsView | null | undefined>()
	useEffect(() => {
		if (!read) return
		let current = true
		const load = () =>
			read().then(
				(answer) => current && setSkills(answer),
				() => current && setSkills(null),
			)
		void load()
		window.addEventListener('focus', load)
		return () => {
			current = false
			window.removeEventListener('focus', load)
		}
	}, [read])
	return read ? skills : null
}

export function SkillSwitches({
	descriptor,
	control,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	control: Of<'list'>
	value: unknown
	config: ConfigSettingsControls
}) {
	const skills = useInstalledSkills(config)
	// An engine that cannot list its skills keeps the typed list.
	if (skills === null)
		return <TypedList descriptor={descriptor} control={control} value={value} config={config} />
	if (skills === undefined) return <p className="settings-note">Reading the installed skills…</p>
	const save = (next: string[] | undefined) =>
		void (next === undefined
			? config.change(descriptor.path)
			: config.change(descriptor.path, next))
	return (
		<SkillSwitchesView
			label={descriptor.label}
			rows={skillSwitchRows(skills.skills, value)}
			onSwitch={(name, on) => save(skillsDisabledValue(value, name, on))}
			onRemoveUnknown={(name) => {
				const next = withoutItem(Array.isArray(value) ? (value as string[]) : [], name)
				save(next.length === 0 ? undefined : next)
			}}
		/>
	)
}

function TypedList({
	descriptor,
	control,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	control: Of<'list'>
	value: unknown
	config: ConfigSettingsControls
}) {
	const items = Array.isArray(value) ? (value as string[]) : []
	return (
		<ListEditor
			label={descriptor.label}
			itemLabel={control.itemLabel}
			placeholder={control.placeholder}
			items={items}
			onChange={(next) => config.change(descriptor.path, next)}
		/>
	)
}

/** The list kind: a saved list of words, with a folder picker or the installed skills when named. */
export function WordList({
	descriptor,
	control,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	control: Of<'list'>
	value: unknown
	config: ConfigSettingsControls
}) {
	if (control.source === 'skills')
		return <SkillSwitches descriptor={descriptor} control={control} value={value} config={config} />
	if (control.picker === 'folder' && config.tools?.pickFolder)
		return <FolderList descriptor={descriptor} value={value} config={config} />
	return <TypedList descriptor={descriptor} control={control} value={value} config={config} />
}

/** The screens a tool result passes, and the tools one of them lets through. */
export function ScreensEditor({
	descriptor,
	control,
	value,
	set,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	control: Of<'screens'>
	value: unknown
	set: boolean
	config: ConfigSettingsControls
}) {
	const { screen, field } = control.passthrough
	const names = set ? screenNames(value) : screenNames(descriptor.default)
	const tools = set ? screenTools(value, screen, field) : []
	const save = (nextNames: string[], nextTools: string[]) => {
		const next = screensValue(nextNames, nextTools, control, descriptor.default)
		return next === undefined
			? config.change(descriptor.path)
			: config.change(descriptor.path, next)
	}
	return (
		<div className="settings-config-list">
			<OptionChecks
				legend={descriptor.label}
				options={control.options}
				ticked={names}
				onChange={(next) => void save(next, tools)}
			/>
			<div className="settings-config-sub">
				<span className="settings-config-sub-label">{control.passthrough.label}</span>
				<ListEditor
					label={control.passthrough.label}
					itemLabel="tool"
					placeholder={control.passthrough.placeholder}
					items={tools}
					disabled={!names.includes(screen)}
					onChange={(next) => save(names, next)}
				/>
			</div>
		</div>
	)
}

/** Choices with every option ticked by default, a note when none is, and All / None. */
export function ManyChecks({
	descriptor,
	control,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	control: Of<'checks'>
	value: unknown
	config: ConfigSettingsControls
}) {
	const ticked = Array.isArray(value) ? (value as string[]) : []
	const all = control.options.map((option) => option.value)
	const save = (next: string[]) =>
		void (next.length === all.length
			? config.change(descriptor.path)
			: config.change(descriptor.path, next))
	return (
		<div className="settings-config-list">
			<span className="settings-config-field">
				<Button variant="outline" size="xs" onClick={() => save(all)}>
					All
				</Button>
				<Button variant="outline" size="xs" onClick={() => save([])}>
					None
				</Button>
			</span>
			<OptionChecks
				legend={descriptor.label}
				options={control.options}
				ticked={ticked}
				onChange={save}
				scroll
			/>
			{ticked.length === 0 && control.emptyNote && (
				<p className="settings-note">{control.emptyNote}</p>
			)}
		</div>
	)
}

/** Reads the models Desktop already knows the first time a model field is used. */
function useModelChoices(config: ConfigSettingsControls): {
	groups: ModelChoiceGroup[]
	ask: () => void
} {
	const read = config.tools?.modelChoices
	const [groups, setGroups] = useState<ModelChoiceGroup[]>([])
	const [asked, setAsked] = useState(false)
	const ask = useCallback(() => {
		if (!read || asked) return
		setAsked(true)
		read().then(setGroups, () => setAsked(false))
	}, [read, asked])
	return { groups, ask }
}

/** The models offered as a person types: each as `provider/model`, with the provider named. */
export function modelOptionRows(
	groups: readonly ModelChoiceGroup[],
): { value: string; label: string }[] {
	return groups.flatMap((group) =>
		group.models.map((model) => ({
			value: `${group.provider}/${model.id}`,
			label: `${group.label}: ${model.label}`,
		})),
	)
}

/**
 * A model typed or picked. The list is the models Desktop already knows, offered as the person
 * types; a name that is not in it is kept as written. `extra` adds words that are not a model.
 */
export function ModelInput({
	label,
	value,
	placeholder,
	extra,
	className,
	config,
	onChange,
	onCommit,
}: {
	label: string
	value: string
	placeholder?: string
	extra?: readonly ConfigSettingOption[]
	className?: string
	config: ConfigSettingsControls
	onChange: (text: string) => void
	/** Called when the person leaves the field or presses Enter. */
	onCommit?: () => void
}) {
	const list = useId()
	const { groups, ask } = useModelChoices(config)
	return (
		<>
			<input
				type="text"
				list={list}
				className={className ?? 'settings-config-input settings-config-wide'}
				aria-label={label}
				value={value}
				placeholder={placeholder ?? ''}
				spellCheck={false}
				autoComplete="off"
				onFocus={ask}
				onChange={(event) => onChange(event.target.value)}
				onBlur={() => onCommit?.()}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault()
						onCommit?.()
					}
				}}
			/>
			<datalist id={list}>
				{extra?.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
				{modelOptionRows(groups).map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</datalist>
		</>
	)
}

/** The model kind: one model, saved as the text written or picked. Empty puts the default back. */
export function ModelSetting({
	descriptor,
	control,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	control: Of<'model'>
	value: unknown
	config: ConfigSettingsControls
}) {
	const saved = typeof value === 'string' ? value : ''
	const [draft, setDraft] = useState<string>()
	const commit = async () => {
		if (draft === undefined || draft.trim() === saved) return setDraft(undefined)
		const ok = await config.change(descriptor.path, draft.trim() === '' ? undefined : draft.trim())
		if (ok) setDraft(undefined)
	}
	return (
		<ModelInput
			label={descriptor.label}
			value={draft ?? saved}
			placeholder={control.placeholder}
			config={config}
			onChange={setDraft}
			onCommit={() => void commit()}
		/>
	)
}

/** One line of a small form: its name and help at the left, its control at the right. */
function FormLine({
	name,
	help,
	children,
}: {
	name: string
	help?: string
	children: React.ReactNode
}) {
	return (
		<li>
			<span className="settings-config-level-name">
				{name}
				{help && <span className="settings-config-help">{help}</span>}
			</span>
			{children}
		</li>
	)
}

const STRATEGIES: readonly ConfigSettingOption[] = [
	{ value: '', label: 'Default (two yes or no questions)' },
	{ value: 'yesno', label: 'Two yes or no questions' },
	{ value: 'score', label: 'One rating' },
]

/**
 * The routing table as a form. Nothing is saved until Save, so a half-filled form never reaches
 * the file; the engine refuses a table with no default model in its own words.
 */
export function RoutingEditor({
	descriptor,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	value: unknown
	config: ConfigSettingsControls
}) {
	const saved = routingForm(value)
	const [draft, setDraft] = useState<RoutingForm>()
	const [local, setLocal] = useState('')
	const form = draft ?? saved
	const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(saved)
	const edit = (patch: Partial<RoutingForm>) => setDraft({ ...form, ...patch })
	const save = async () => {
		const built = routingValue(form, value)
		if ('error' in built) return setLocal(built.error)
		setLocal('')
		if (await config.change(descriptor.path, built.value)) setDraft(undefined)
	}
	const field = (
		name: string,
		help: string,
		key: 'default' | 'fast' | 'big',
		placeholder: string,
	) => (
		<FormLine name={name} help={help}>
			<ModelInput
				label={name}
				value={form[key]}
				placeholder={placeholder}
				className="settings-config-input settings-config-model"
				config={config}
				onChange={(text) => edit({ [key]: text })}
			/>
		</FormLine>
	)
	return (
		<div className="settings-config-list">
			<ul className="settings-config-levels">
				{field(
					'Default model',
					'Used whenever Namzu does not choose another.',
					'default',
					'provider/model',
				)}
				{field('Fast model', 'For short questions and one-step tasks.', 'fast', 'Not used')}
				{field('Large model', 'For long, many-step work.', 'big', 'Not used')}
				<FormLine name="How a task is sized">
					<select
						className="settings-config-input"
						aria-label="How a task is sized"
						value={form.strategy}
						onChange={(event) => edit({ strategy: event.target.value })}
					>
						{STRATEGIES.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</FormLine>
				<FormLine name="Time to decide" help="Longest wait before the default model is used.">
					<span className="settings-config-field">
						<input
							type="text"
							inputMode="decimal"
							className="settings-config-input settings-config-number"
							aria-label="Time to decide in seconds"
							value={form.timeout}
							placeholder="1.5"
							spellCheck={false}
							onChange={(event) => edit({ timeout: event.target.value })}
						/>
						<span className="settings-config-unit">seconds</span>
					</span>
				</FormLine>
			</ul>
			{local && (
				<p role="alert" className="settings-error settings-config-error">
					{local}
				</p>
			)}
			<span className="settings-config-actions">
				<Button variant="outline" size="sm" disabled={!dirty} onClick={() => void save()}>
					Save
				</Button>
				{dirty && (
					<Button
						variant="ghost-muted"
						size="sm"
						onClick={() => {
							setDraft(undefined)
							setLocal('')
						}}
					>
						Discard
					</Button>
				)}
			</span>
		</div>
	)
}

/** The auto mode reviewer: its model, and four lists of sentences that steer it. */
export function AutoModeEditor({
	descriptor,
	control,
	value,
	config,
}: {
	descriptor: ConfigSettingDescriptor
	control: Of<'auto-mode'>
	value: unknown
	config: ConfigSettingsControls
}) {
	const savedModel = autoModeModel(value)
	const [model, setModel] = useState<string>()
	const save = (next: Record<string, unknown> | undefined) =>
		next === undefined ? config.change(descriptor.path) : config.change(descriptor.path, next)
	const commitModel = async () => {
		if (model === undefined || model.trim() === savedModel) return setModel(undefined)
		const next = autoModeSet(value, { model: model.trim() === '' ? undefined : model.trim() })
		if (await save(next)) setModel(undefined)
	}
	return (
		<div className="settings-config-list">
			<ul className="settings-config-levels">
				<FormLine name="Reviewer model" help="Left empty, the conversation's own model reviews.">
					<ModelInput
						label="Reviewer model"
						value={model ?? savedModel}
						placeholder="provider/model"
						extra={[{ value: SMALL_MODEL_WORD, label: 'The small model (cheaper, for side jobs)' }]}
						className="settings-config-input settings-config-model"
						config={config}
						onChange={setModel}
						onCommit={() => void commitModel()}
					/>
				</FormLine>
			</ul>
			{control.lists.map((list) => {
				const own = autoModeList(value, list.value)
				return (
					<div key={list.value} className="settings-config-sub">
						<span className="settings-config-sub-label">
							{list.label}
							{list.help && <span className="settings-config-help">{list.help}</span>}
						</span>
						<ListEditor
							label={list.label}
							itemLabel="rule"
							placeholder="A sentence describing the action"
							items={own ?? [DEFAULTS_ENTRY]}
							itemText={autoEntryLabel}
							onChange={(next) => save(autoModeSet(value, { [list.value]: next }))}
						/>
						{own !== undefined && (
							<span>
								<Button
									variant="ghost-muted"
									size="xs"
									onClick={() => void save(autoModeSet(value, { [list.value]: undefined }))}
									aria-label={`Use the built-in rules for ${list.label}`}
								>
									Use built-in rules
								</Button>
							</span>
						)}
					</div>
				)
			})}
		</div>
	)
}
