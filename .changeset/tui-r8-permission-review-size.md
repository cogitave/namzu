---
'@namzu/cli': minor
---

A large write, edit or command now opens the approval prompt instead of being refused. The input is shown in a page of rows with the rest one key away (PgDn, or `d` for the exact input). A value over 200 thousand characters, or the part of a batch past 1 MiB, is replaced by a short notice (`[about 200k characters not shown]`), and only a one-time Yes and No are offered: no "switch to accept edits" and no "don't ask again". The same holds for a connected server's tool whose input reads as more than 2,000 units of one line, more than 10,000 elements or deeper than 64 levels; its input is still shown whole. One notice covers a batch and each marked call is flagged beside its number. Approving binds the exact input; if it changed after the prompt opened, the call is refused. Input that is not plain JSON is still refused. The hint line keeps the `d` key at narrow widths. Nothing to do. No exported symbol changed; the review module is internal to the CLI.
