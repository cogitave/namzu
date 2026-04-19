---
title: Action Reference
description: Complete action-level reference for the computer_use tool and the ComputerUseHost contract in Namzu.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/computer-use", "@namzu/sdk"]
---

# Action Reference

The `computer_use` tool exposes one discriminated action union. This page is the action-by-action reference you can use when building prompts, tests, or MCP-facing docs.

## 1. Coordinate Model

All pointer coordinates are:

- logical pixels
- measured from the top-left of the primary display
- interpreted by the current host adapter

In practice, the safest sequence for GUI work is:

1. take a screenshot
2. inspect the returned image dimensions
3. choose coordinates inside those bounds
4. move or click

## 2. Action Matrix

| Action type | Input shape | Result shape | Required capability | Destructive |
| --- | --- | --- | --- | --- |
| `screenshot` | `{ type: 'screenshot' }` | base64 PNG via `ToolResult.output` | `screenshot` | No |
| `cursor_position` | `{ type: 'cursor_position' }` | current `{ x, y }` | `cursorPosition` | No |
| `mouse_move` | `{ type: 'mouse_move', to: { x, y } }` | `ok` | `mouse` | No |
| `mouse_click` | `{ type: 'mouse_click', at: { x, y }, button }` | `ok` | `mouse` | Yes |
| `mouse_drag` | `{ type: 'mouse_drag', from: { x, y }, to: { x, y }, button }` | `ok` | `mouse` | Yes |
| `scroll` | `{ type: 'scroll', at: { x, y }, direction, amount }` | `ok` | `mouse` | Yes |
| `type_text` | `{ type: 'type_text', text }` | `ok` | `keyboard` | Yes |
| `key` | `{ type: 'key', keys }` | `ok` | `keyboard` | Yes |

## 3. Screenshot

Input:

```ts
{ type: 'screenshot' }
```

Tool result behavior:

- `ToolResult.output` contains base64 PNG data
- `ToolResult.data` includes:
  - `mimeType`
  - `width`
  - `height`
  - `encoding: 'base64'`

Use screenshot first whenever the model or operator needs visual grounding.

## 4. Cursor Position

Input:

```ts
{ type: 'cursor_position' }
```

Returns:

```ts
{ x: number, y: number }
```

This action only works when the adapter exposes `cursorPosition: true`.

## 5. Mouse Actions

### 5.1 `mouse_move`

```ts
{ type: 'mouse_move', to: { x: 640, y: 240 } }
```

Use it when the next action needs pointer positioning without immediate input.

### 5.2 `mouse_click`

```ts
{ type: 'mouse_click', at: { x: 640, y: 240 }, button: 'left' }
```

Buttons:

- `left`
- `right`
- `middle`

This action is marked destructive because it changes UI state.

### 5.3 `mouse_drag`

```ts
{
  type: 'mouse_drag',
  from: { x: 200, y: 300 },
  to: { x: 900, y: 300 },
  button: 'left',
}
```

Use drag for:

- slider movement
- selection
- window repositioning
- drag-and-drop UI

### 5.4 `scroll`

```ts
{
  type: 'scroll',
  at: { x: 900, y: 700 },
  direction: 'down',
  amount: 600,
}
```

Directions:

- `up`
- `down`
- `left`
- `right`

`amount` must be a positive integer.

## 6. Keyboard Actions

### 6.1 `type_text`

```ts
{ type: 'type_text', text: 'hello world' }
```

Use it when literal text entry is intended.

### 6.2 `key`

```ts
{ type: 'key', keys: 'cmd+shift+t' }
```

Examples:

- `Return`
- `Escape`
- `ctrl+c`
- `cmd+shift+t`
- `alt+tab`

Use `key` for shortcuts or special keys rather than raw text entry.

## 7. Host Contract vs Tool Result

At the host layer, `ComputerUseHost.execute(action)` returns:

- `screenshot`
- `cursor_position`
- `ok`

At the tool layer, `createComputerUseTool()` converts that into standard `ToolResult` output. That is why screenshots appear as base64 output instead of raw buffers when invoked through the SDK tool surface.

## 8. Capability Gating

The tool wrapper checks the host's capability map before executing an action. If the capability is missing, the tool fails clearly instead of hanging.

Typical examples:

- `cursor_position` on Wayland often fails because `cursorPosition` is false
- `mouse_move` on macOS may require optional tooling for richer mouse support
- keyboard input can fail if the host session is not interactive

## 9. Recommended Action Patterns

### 9.1 Visual-first navigation

1. `screenshot`
2. inspect image
3. `mouse_move`
4. `mouse_click`

### 9.2 Form entry

1. `mouse_click` to focus
2. `type_text`
3. `key` with `Return` or `Tab` as needed

### 9.3 Scrolling through content

1. `screenshot`
2. `scroll`
3. `screenshot` again to confirm state change

## Related

- [Computer Use](./README.md)
- [Host Lifecycle](./host-lifecycle.md)
- [Platform Support](./platform-support.md)
- [Computer Use Types](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/types/computer-use/index.ts)
- [Computer Use Tool Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/tools/builtins/computer-use.ts)
