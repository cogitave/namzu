---
'@namzu/cli': minor
---

New `/init` slash command: writes an `AGENTS.md` describing the current project
to future agents.

It works by asking the agent, not by generating a template. The kernel already
reads the tree and writes files, so `/init` composes an instruction and drives an
ordinary turn — a CLI-side generator would produce a directory listing with
headings on it, and would become a second way to inspect a repository that then
disagreed with the one the model uses.

The instruction it sends is the substance. It asks for every claim to be verified
against the tree and for omission over invention, in those words, because an
`AGENTS.md` full of plausible-looking conventions is worse than no file at all:
the next agent obeys it.

It knows what is already there. When project instructions are loaded, `/init`
names them and asks for proposed edits rather than a rewrite; when there are
none, it asks for a new file at the repository root. The session already reports
which instruction files are in force, so nothing is discovered to answer this.

Without a provider it says so and stops, since there is no agent to ask.
