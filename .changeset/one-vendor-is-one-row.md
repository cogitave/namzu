---
'@namzu/cli': minor
---

The provider picker draws one row per vendor, and offers each way to
authenticate that vendor inside the row.

The duplicate was real and it was reported from a screen like this one: a
machine with the subscription signed in drew `OpenAI (Codex subscription)` as a
detected row and, below it under `Not detected — enter a credential to use
these:`, the same vendor again asking for `OPENAI_API_KEY`. The registry models
a subscription sign-in and an API key as two provider ids, and the list was a
list of ids — so one product read as two, and the operator holding the key had
to work out which of the two rows was theirs.

A row is now a vendor. It says what this machine has (`Codex session · this
device`) or what is missing (`needs OPENAI_API_KEY`), and entering it offers its
ways in — the detected subscription first, then the API key, then a sign-in
where nothing works yet. Each choice leads where that way in already led: a
detected session opens the vendor's models, a credential opens the paste field,
a sign-in starts the operation `l` starts. No second credential mechanism was
built: a typed key still travels the same `setKeyEntry` → `acceptKey` →
session-credential path, and nothing about credential resolution at run time
changed. No config key was added.

**What moves.** Five shapes a reader may have matched change on this screen.
The detected block keeps discovery's order, but a vendor that was two rows is
one, so rows below it renumber. A detected row is titled by its vendor rather
than by its registry entry, which changes exactly one row in this registry —
the subscription row now reads `OpenAI` with its session in the source column,
where it used to read `OpenAI (Codex subscription)`. Where a row's ways in name
more than one provider, Enter opens a choice screen instead of acting
immediately; in this registry that is one row, the vendor whose two ids are a
subscription and a key, and its detected session is the first item and the
initial cursor. Every other row keeps the keystroke it always had — an
unconfigured row opens its paste field, a detected row opens its models — so
the daily path is unchanged. One row that had only one way in now has two: a
vendor with neither a session nor a key offers the key first and the sign-in
second, where before it went straight to the paste field. And the list is
shorter: nine vendors is the most it can draw, so the digit shortcut's nine-row
limit is now a bound this screen cannot pass, and the sentence about the rows
past nine no longer appears.

That last one is why this is `minor` rather than `patch` — the same reason the
previous picker change gave. No exported symbol, CLI flag, config key, default
or wire shape moved; `ProviderRegistryEntry` gained a required `vendor` field
and a vendor table, which is the CLI's own integration layer rather than a
published surface. A screen whose rows a script or a reader may have matched is
a screen whose changes are visible to them, and a renumbered list is the most
visible kind.

**What did not merge.** Zen and Zen Go are one company's two services, not two
credentials for one product: separate catalogues, separate billing routes and
keys that do not open each other, so a single row would put a product decision
under a heading about authentication, and the word `Go` is the only thing
telling an operator they are choosing between two priced things. Ollama and LM
Studio are two different local servers. AWS Bedrock and `http` remain absent
from the list entirely, for the reasons recorded beside them.

**Four more things, found by running it on a real terminal at 60x20 and 50x20** —
sizes no rendering test used, which is why the tests were green. The text area
was computed as `columns - 4` and the app's own one-column inset on each side
was not counted, so a row was measured two columns wider than it was drawn and
the note beside the model just marked `(current)` wrapped onto a line of its
own; the width is derived from all three terms now. A row wider than the box is
squeezed by the renderer and loses the trailing space of the text nodes it is
built from, which is how the cursor row came out as `›6. DeepSeek` — the row's
segments are children of one text node now, and its source column is wrapped by
the screen so it stays inside the box. The box was as tall as its rows wanted,
so on a 20-row terminal Ink scrolled it and the notice explaining the screen —
the first thing an operator needs — was above the top of it; the height is
counted from the lines the screen will draw, and the list is windowed to fit
with the window following the cursor. And `(free)` printed twice on 22 of the
25 zero-priced rows of the catalogue this was measured against, whose own names
end in `(free)`: the marker stays, the repetition goes, and the rule reads the
word rather than one vendor's punctuation. Two smaller ones: the sentences the
box is sized against are wrapped by the screen, so a continuation no longer
begins with the space Ink broke at, and the footer says what `esc` does —
`esc cancel` returns to the session behind the picker, `esc exit namzu` closes
the program, which is what it did all along with nothing behind it.
