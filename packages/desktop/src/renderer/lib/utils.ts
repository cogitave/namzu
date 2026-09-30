import { type CxOptions, cx } from 'class-variance-authority'
import { extendTailwindMerge } from 'tailwind-merge'

// Shared class merging for the imported component variants and semantic type scale.
const merge = extendTailwindMerge({
	extend: { theme: { text: ['ui-base', 'ui-caption', 'ui-sm'] } },
})
export function cn(...inputs: CxOptions) {
	return merge(cx(inputs))
}
