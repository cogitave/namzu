---
'@namzu/cli': patch
---

The context gauge in the status footer reports the context, not the bill

The `ctx` bar divided **cumulative run spend** by a context window guessed from
a substring of the model name. Neither term was the thing it claimed.

Cumulative spend is monotone by design — it exists so a run can never
under-report a bill — and it grows superlinearly in turn count, because every
turn re-sends the whole history and counts those prompt tokens again. Ten turns
over a 50k context accumulate roughly 500k. So the bar **saturated**: a long
conversation read FULL while the real context might be a fifth of the window,
and it was most wrong exactly where a user relies on it. People were compacting
sessions that had room.

It now reads the figures the kernel already measures and ships on
`token_usage_updated`: `contextTokens` over `contextWindowTokens`. The
model-name guess is deleted, so a window is whatever the run actually resolved
rather than 200k-or-1M.

Two things a reader of the bar should know:

- **A `~` before the percentage means the ratio is inferred, not measured.** It
  appears when the kernel estimated the prompt size instead of the provider
  counting it, **and also when the window itself is the assumed default** — an
  exact count over an invented denominator is still a guess, and marking only
  the numerator would repeat the original error one level down.
- **No bar at all when either term is missing.** Runs that resolve no window
  report no context figures, and a fraction that cannot be grounded is not an
  approximation of anything. The token and cost figures still show; only the
  proportion is withheld.

Nothing to change on upgrade — no public export moved. The spend figure beside
the bar is unchanged and still cumulative.
