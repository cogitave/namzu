---
'@namzu/sdk': minor
---

Child loggers name their scope with a reserved attribute instead of an
unnamespaced `component` key.

`.child({ component: 'ToolRegistry' })` put a bare `component` key into the
attribute bag of every record that logger emitted. It collides with nothing
today and with anything tomorrow: OTel's semantic conventions own the
unprefixed namespace, and a record whose attributes carry both a
convention-defined key and this one has no way to say which meant what.

`SCOPE_ATTRIBUTE` is a reserved key that both logger backends — the OTel-shaped
pipeline and the legacy `Logger` that `getRootLogger()` returns — lift onto
`scope.name` and remove from `attributes`, so the value lands in the field the
Logs Data Model has for it rather than beside it. Thirteen of the SDK's
forty-eight binding sites are converted here; the gate's
`unnamespacedBindingCount` ratchet moves 48 → 40 and the rest follow.

The ratchet is why this can land in pieces without the remainder being
forgotten: it fails on any mismatch, so each batch has to write its own number
down.
