import { type CxOptions, cx } from 'class-variance-authority'
import { twMerge } from 'tailwind-merge'

// Shared class merging for the imported component variants. The type scale is the Tailwind
// aliases in theme.css (text-xs, text-sm, text-base ...); there are no other text size names.
const merge = twMerge
export function cn(...inputs: CxOptions) {
	return merge(cx(inputs))
}
