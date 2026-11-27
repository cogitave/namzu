import { Menu } from '@base-ui/react/menu'
import { Tabs } from '@base-ui/react/tabs'
import { type ComponentType, type ReactNode, type SVGProps, useEffect, useRef } from 'react'
import {
	CUSTOMIZE_TABS,
	type CustomizeTab,
	SKILL_SORTS,
	type SkillSort,
} from './customize-model.js'
import {
	CheckIcon,
	ChevronDownIcon,
	MoreHorizontalIcon,
	PlusIcon,
	SearchIcon,
	SortIcon,
	XIcon,
} from './icons.js'
import { MENU_OFFSET } from './menu-metrics.js'
import { Button } from './ui/button.js'

/** The small pieces the Customize page is drawn from: menus, chips, tiles and the header row. */

export interface MenuEntry {
	label: string
	onSelect: () => void
	icon?: ComponentType<SVGProps<SVGSVGElement>>
	disabled?: boolean
	title?: string
	checked?: boolean
}

function MenuItems({ items }: { items: readonly MenuEntry[] }) {
	return (
		<>
			{items.map((item) => (
				<Menu.Item
					key={item.label}
					className="menu-item"
					disabled={item.disabled}
					title={item.title}
					onClick={item.onSelect}
				>
					{item.icon && <item.icon aria-hidden="true" />}
					<span>{item.label}</span>
					{item.checked && (
						<span className="menu-check" aria-hidden="true">
							<CheckIcon />
						</span>
					)}
				</Menu.Item>
			))}
		</>
	)
}

export function MenuPopup({
	label,
	items,
	align = 'end',
}: { label: string; items: readonly MenuEntry[]; align?: 'start' | 'end' }) {
	return (
		<Menu.Portal>
			<Menu.Positioner
				className="z-(--z-popover) outline-none"
				align={align}
				sideOffset={MENU_OFFSET}
			>
				<Menu.Popup aria-label={label} className="menu-popup">
					<MenuItems items={items} />
				</Menu.Popup>
			</Menu.Positioner>
		</Menu.Portal>
	)
}

/** The ⋯ button of a row or a header, with its menu. */
export function MoreMenu({
	label,
	items,
	className,
}: { label: string; items: readonly MenuEntry[]; className?: string }) {
	return (
		<Menu.Root>
			<Menu.Trigger
				render={
					<Button
						variant="ghost-muted"
						size="icon-sm"
						className={`customize-more ${className ?? ''}`}
						aria-label={label}
					/>
				}
			>
				<MoreHorizontalIcon />
			</Menu.Trigger>
			<MenuPopup label={label} items={items} />
		</Menu.Root>
	)
}

export function Chip({ children, tone }: { children: ReactNode; tone?: 'off' }) {
	return (
		<span className="customize-chip" data-tone={tone}>
			{children}
		</span>
	)
}

export function Tile({
	icon: Icon,
	size = 36,
}: { icon: ComponentType<SVGProps<SVGSVGElement>>; size?: 36 | 44 }) {
	return (
		<span className="customize-tile" data-size={size} aria-hidden="true">
			<Icon />
		</span>
	)
}

export function CountChip({ count }: { count: number }) {
	return <span className="customize-count">{count}</span>
}

export function GroupHeading({ title, count }: { title: string; count: number }) {
	return (
		<h2 className="customize-group-heading">
			{title}
			<CountChip count={count} />
		</h2>
	)
}

export interface AddMenuModel {
	items: readonly MenuEntry[]
}

export function CustomizeHeader({
	tab,
	onTab,
	query,
	onQuery,
	sort,
	onSort,
	add,
	searchLabel,
}: {
	tab: CustomizeTab
	onTab: (tab: CustomizeTab) => void
	query: string
	onQuery: (query: string) => void
	sort: SkillSort
	onSort: (sort: SkillSort) => void
	add?: AddMenuModel
	searchLabel: string
}) {
	return (
		<div className="customize-controls">
			<Tabs.List className="customize-tabs" aria-label="Customize sections">
				{CUSTOMIZE_TABS.map((item) => (
					<Tabs.Tab
						key={item.id}
						value={item.id}
						className="customize-tab"
						onClick={() => onTab(item.id)}
					>
						{item.label}
					</Tabs.Tab>
				))}
			</Tabs.List>
			<div className="customize-tools">
				<div className="customize-search">
					<SearchIcon aria-hidden="true" />
					<input
						type="search"
						aria-label={searchLabel}
						placeholder="Search"
						value={query}
						onChange={(event) => onQuery(event.target.value)}
					/>
					{query && (
						<button
							type="button"
							className="customize-search-clear"
							aria-label="Clear search"
							onClick={() => onQuery('')}
						>
							<XIcon />
						</button>
					)}
				</div>
				{tab !== 'connectors' && (
					<Menu.Root>
						<Menu.Trigger
							render={
								<Button
									variant="ghost-muted"
									size="icon-sm"
									className="customize-sort"
									aria-label="Sort"
								/>
							}
						>
							<SortIcon />
						</Menu.Trigger>
						<MenuPopup
							label="Sort"
							items={SKILL_SORTS.map((item) => ({
								label: item.label,
								checked: sort === item.id,
								onSelect: () => onSort(item.id),
							}))}
						/>
					</Menu.Root>
				)}
				{add && (
					<Menu.Root>
						<Menu.Trigger render={<button type="button" className="customize-add" />}>
							<PlusIcon aria-hidden="true" />
							Add
							<ChevronDownIcon aria-hidden="true" />
						</Menu.Trigger>
						<MenuPopup label="Add" items={add.items} />
					</Menu.Root>
				)}
			</div>
		</div>
	)
}

export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
	return (
		<div className="customize-empty">
			<p>{children}</p>
			{action}
		</div>
	)
}

/** A detail page's frame: the back link, the header and its actions, then the tabs. */
export function DetailFrame({
	backLabel,
	onBack,
	tile,
	title,
	subtitle,
	actions,
	note,
	onEscape,
	children,
}: {
	backLabel: string
	onBack: () => void
	tile: ReactNode
	title: string
	subtitle: string
	actions?: ReactNode
	note?: ReactNode
	onEscape?: () => void
	children: ReactNode
}) {
	const back = useRef(onEscape ?? onBack)
	back.current = onEscape ?? onBack
	// Escape goes back from anywhere on the page, unless a menu or a dialog is open and takes it first.
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
			const target = event.target instanceof Element ? event.target : undefined
			if (target?.closest('[role="dialog"], [role="menu"], [data-slot="popover-popup"]')) return
			if (document.querySelector('[role="menu"], [role="dialog"]')) return
			event.preventDefault()
			back.current()
		}
		document.addEventListener('keydown', key)
		return () => document.removeEventListener('keydown', key)
	}, [])
	return (
		<section className="customize-detail" aria-label={`${title} details`}>
			<button type="button" className="customize-back" onClick={onBack}>
				<span aria-hidden="true">←</span>
				{backLabel}
			</button>
			<header className="customize-detail-header">
				{tile}
				<div className="customize-detail-copy">
					<h2>{title}</h2>
					<p>{subtitle}</p>
				</div>
				{actions && <div className="customize-detail-actions">{actions}</div>}
			</header>
			{note && <p className="customize-detail-note">{note}</p>}
			{children}
		</section>
	)
}

export function DetailTabs<T extends string>({
	onChange,
	tabs,
	label,
}: {
	onChange: (value: T) => void
	tabs: readonly { id: T; label: string; count?: number }[]
	label: string
}) {
	return (
		<Tabs.List className="customize-detail-tabs" aria-label={label}>
			{tabs.map((item) => (
				<Tabs.Tab
					key={item.id}
					value={item.id}
					className="customize-detail-tab"
					onClick={() => onChange(item.id)}
				>
					{item.label}
					{item.count !== undefined && (
						<span className="customize-detail-tab-count"> · {item.count}</span>
					)}
				</Tabs.Tab>
			))}
		</Tabs.List>
	)
}
