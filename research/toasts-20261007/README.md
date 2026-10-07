# Toasts, 2026-10-07

Proof for wave 2 of `research/ai-tool-landscape-20261007/PLAN.md`: one notification system on Base UI Toast
(`@base-ui/react/toast` 1.4.1, no new package) replacing the single-string notice in `app.tsx`.

Re-run with the desktop dev server up: `node research/toasts-20261007/capture.mjs` (prints PASS/FAIL, rewrites `artifacts/`; last output in `capture-output.txt`).
The script reaches the page's own `notify` through Vite (`import('/src/renderer/notify.ts')`), so it drives the same hub the app calls.

- `01-one-{dark,light}` a single success toast.
- `02-three-stacked-*` three toasts: newest in front, older ones peek behind.
- `03-three-fanned-open-*` pointer over the stack fans it open (timers pause).
- `04-action-*` a toast with an action button (Undo).
- `05-error-*` an error toast (announced through the assertive region).

Asserted: stack of three, `data-expanded` on hover, polite live region, action runs once and closes its toast,
toast sits above the composer and inside the conversation lane (clear of the side panel), reduced motion sets a zero transition,
a plain toast leaves by itself.

Unit tests: `packages/desktop/src/renderer/notify.test.ts` (fake timers, and the real Base UI store for lifetimes).
