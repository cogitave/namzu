import type { ComponentProps } from 'react'

import { cn } from './lib/utils.js'

/** One glass backdrop behind the box. */
function Shell({ className, ...props }: ComponentProps<'div'>) {
	return (
		<div
			data-slot="composer-shell"
			className={cn(
				'@container/composer-surface group/composer-surface relative isolate mx-auto w-full max-w-(--chat-max-width)',
				'[--chat-composer-glass-surface:var(--card)] [--chat-composer-outline:rgb(0_0_0/8%)]',
				'dark:[--chat-composer-glass-surface:var(--surface-raised)] dark:[--chat-composer-highlight:rgb(255_255_255/3%)] dark:[--chat-composer-outline:color-mix(in_srgb,var(--color-white)_5%,transparent)]',
				'before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-3xl before:bg-(--chat-composer-glass-surface)/(--glass-opacity) before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)',
				'not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-glass-surface)',
				className,
			)}
			{...props}
		/>
	)
}

const outlineClasses =
	'after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-(--chat-composer-outline) dark:after:inset-shadow-2xs dark:after:inset-shadow-(color:--chat-composer-highlight)'

function Host({ className, ...props }: ComponentProps<'div'>) {
	return (
		<div
			data-slot="composer-host"
			className={cn(
				'relative z-10 w-full rounded-3xl shadow-composer after:z-1 dark:shadow-none',
				outlineClasses,
				className,
			)}
			{...props}
		/>
	)
}

function Main({ className, ...props }: ComponentProps<'div'>) {
	return (
		<div
			data-chat-composer-main-surface="true"
			className={cn(
				'group relative z-10 rounded-3xl p-px transition-colors duration-200',
				outlineClasses,
				className,
			)}
			{...props}
		/>
	)
}

export const ComposerSurface = { Shell, Host, Main }
