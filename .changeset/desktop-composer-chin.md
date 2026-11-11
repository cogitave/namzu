---
"@namzu/desktop": minor
"@namzu/cli": patch
---

The home screen's composer is quieter, and the model popup opens on the models. The box's lower edge carries the attach "+", the permission word, the model word and Send; permission and model are plain muted text (the chevron shows on hover) and Send is the only filled control. The microphone button is hidden until voice input is set up: turn it on in Settings ▸ Speech ▸ Voice input (search "microphone"), and the button is back. The project and "This computer" are one line above the box with one menu. The three starters are small rows; clicking one fills the box and never sends it.

The model popup opens on the model list, each row with its context window and price when the model's source published them (nothing is shown for a value that is not known). Under the list are the reasoning-effort slider and one "More" row; the engine, the Desktop or CLI switch and the provider filter (when you have two or more providers) moved behind it, so they are one click further than before and nothing is removed. There is no setting to restore the old arrangement.

In the CLI, `namzu acp --desktop` model lists carry the window and the per-million-token rates a provider published (`contextWindow`, `inputPrice`, `outputPrice` on a row); a row without them is unchanged.
