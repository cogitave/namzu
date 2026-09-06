import { theme } from './theme.js'

/** The three-point signature used beside Namzu's replies and compact header. */
export const NAMZU_MARK = '∴'
export const NAMZU_MARK_COLOR = theme.accent.assistant

/** A four-cell N drawn as one continuous stroke, with no gradient or filled canvas. */
export const NAMZU_MONOGRAM = ['╭╮ ╷', '│╰╮│', '╵ ╰╯'] as const
export const NAMZU_MONOGRAM_MIN_WIDTH = 52
