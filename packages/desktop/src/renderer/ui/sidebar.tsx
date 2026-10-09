import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { type VariantProps, cva } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '../lib/utils.js'
import { Input, type InputProps } from './input.js'
function SidebarInput({ className, ...props }: Omit<InputProps, 'unstyled' | 'variant'>) {
	return (
		<Input
			className={cn(
				'[&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:placeholder:text-sidebar-muted-foreground',
				className,
			)}
			unstyled
			{...props}
		/>
	)
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			className={cn('flex flex-col gap-2 p-2', className)}
			data-sidebar="header"
			data-slot="sidebar-header"
			{...props}
		/>
	)
}

function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			className={cn('flex flex-col gap-2 px-[var(--sidebar-content-inset)] py-1', className)}
			data-sidebar="footer"
			data-slot="sidebar-footer"
			{...props}
		/>
	)
}

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			className={cn(
				'relative flex w-full min-w-0 flex-col p-[var(--sidebar-content-inset)]',
				className,
			)}
			data-sidebar="group"
			data-slot="sidebar-group"
			{...props}
		/>
	)
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
	return (
		<ul
			className={cn('flex w-full min-w-0 flex-col gap-1', className)}
			data-sidebar="menu"
			data-slot="sidebar-menu"
			{...props}
		/>
	)
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
	return (
		<li
			className={cn('group/menu-item relative', className)}
			data-sidebar="menu-item"
			data-slot="sidebar-menu-item"
			{...props}
		/>
	)
}

const sidebarMenuButtonVariants = cva(
	"peer/menu-button flex w-full cursor-pointer items-center gap-[var(--sidebar-control-gap)] overflow-hidden text-left outline-hidden ring-ring transition-[width,height,padding] hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 active:bg-sidebar-row-active active:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:opacity-64 data-[active=true]:bg-sidebar-row-selected data-[active=true]:font-medium data-[active=true]:text-sidebar-foreground data-[state=open]:hover:bg-sidebar-row-hover data-[state=open]:hover:text-sidebar-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-[var(--sidebar-content-inset)]! [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--sidebar-icon-color)] hover:[&>svg]:text-sidebar-foreground active:[&>svg]:text-sidebar-foreground data-[active=true]:[&>svg]:text-sidebar-foreground",
	{
		defaultVariants: {
			size: 'default',
			variant: 'default',
		},
		variants: {
			size: {
				default:
					'h-8 rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] py-1.5 text-sm',
				icon: 'size-8 justify-center rounded-[var(--control-radius)] p-0',
				lg: 'h-12 rounded-lg p-2 text-sm group-data-[collapsible=icon]:p-0!',
				sm: 'h-7 rounded-lg p-2 text-xs',
			},
			variant: {
				default: 'font-medium text-sidebar-muted-foreground/80',
				outline: 'bg-sidebar-control-surface ring-1 ring-sidebar-border',
			},
		},
	},
)

function SidebarMenuButton({
	isActive = false,
	variant = 'default',
	size = 'default',
	className,
	render,
	...props
}: useRender.ComponentProps<'button'> & { isActive?: boolean } & VariantProps<
		typeof sidebarMenuButtonVariants
	>) {
	const defaults = {
		className: cn(sidebarMenuButtonVariants({ size, variant }), className),
		'data-active': isActive,
		'data-sidebar': 'menu-button',
		'data-size': size,
		'data-slot': 'sidebar-menu-button',
		type: 'button' as const,
	}
	return useRender({
		defaultTagName: 'button',
		render,
		props: mergeProps<'button'>(defaults, props),
	})
}
export {
	SidebarInput,
	SidebarHeader,
	SidebarFooter,
	SidebarGroup,
	SidebarMenu,
	SidebarMenuItem,
	SidebarMenuButton,
}
