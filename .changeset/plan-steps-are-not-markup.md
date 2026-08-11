---
'@namzu/sdk': minor
---

`approve_plan` now advertises a closed model-facing input schema, and its
string fallback stops turning markup into steps.

A model that serialises `steps` instead of building it tends to reach for
XML. The fallback split that string on newlines, so `<steps>`, `<step>` and
`</step>` each became a step — and a host numbered them in its approval card
and asked a person to approve `</steps>`. Observed on a real run.

Two changes, in the order they matter:

- `modelInputSchema` + `enforceModelInput`, the same instrument
  `ask_user_question` already carries for the same failure. A capable
  provider now constrains generation to the closed shape, so the array is
  not serialised in the first place. The schema stays inside the strict
  subset (`assertStrictSchema` is what would refuse it).
- The fallback reads the `<description>` blocks the model named when there
  are any, drops tag-only lines when there are not, and yields no steps at
  all for a string carrying no words — rather than inventing one that reads
  `<steps>`.

Nothing to do on upgrade. A host that renders `plan.steps` verbatim gets
sentences where it used to get fragments; a host that already worked around
this can drop the workaround.
