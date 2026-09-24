---
"@namzu/cli": major
---

**Words you type in the interactive composer can now act for that message — on by default.** This changes what existing keystrokes do, so it is a major version.

- `hypermode` at the start or end of a message (or clause) arms a one-turn hypermode: that turn runs at the model's highest published effort and the model is asked to delegate independent work to parallel agents. The next turn gets neither, and `/hypermode` (the session setting) is not turned on.
- "save this as a skill", "turn it into a skill", "bunu skill olarak kaydet", "bunu skill'e çevir", "bundan bir skill yap" and their request forms (`kaydeder misin`, `kaydedebilir misin`, `kaydedelim mi`, …) run `/skills save` after the turn — only when that turn completed, did tool work and did not already save a skill. A message that is only the phrase runs `/skills save` at once.
- Schedule phrases ("run it every day", "bunu her sabah çalıştır") are only suggested; they never act on their own.

Before you press Enter, the words are highlighted and a row above the input says exactly what will happen, for example `✦ hypermode · this turn: effort xhigh, delegate to parallel agents · alt+w drop`. **Alt+W** drops it for that message; Backspace right after `hypermode` drops it too. Only keys you type arm a trigger: pasted, recalled or edited text only shows a suggestion (`✧ hypermode? · alt+w arms`), and loops, pickers, `namzu exec`, `drain`, ACP and scheduled runs never act on these words. Talking about a word does not arm it: "what is hypermode?", a word in the middle of a sentence, in quotes, in code or in a path stays prose. A trigger grants nothing and skips no confirmation; `save_skill` and scheduled jobs still show their own screens. Your message reaches the model and the log unchanged.

**To keep the old behaviour**, turn composer triggers off with `/config triggers off` (writes the user config), or in `~/.namzu/config.yaml`:

```yaml
composerTriggers:
  enabled: false
```

Or keep the feature and turn one trigger down: `composerTriggers.builtin.hypermode: suggest` (or `off`), likewise `save-skill`. A project's `namzu.config.json` can turn triggers off or down for that project but cannot turn them back on over your user file. The `composerTriggers` key is new on the exported `NamzuCliConfig` type.
