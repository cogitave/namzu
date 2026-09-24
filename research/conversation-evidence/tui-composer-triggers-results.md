# Composer triggers and hypermode in the real TUI

The built CLI (`packages/cli/dist/bin.js` at `2cfed5cc`) driven in a real PTY by `tui-composer-triggers-drive.py`, frames rendered through `@xterm/headless`. A fresh `NAMZU_HOME` per run: the trust prompt answered `y`, then `2` (OpenAI, Codex session) in the provider picker, then `/model gpt-5.6-luna`. Real model: codex/gpt-5.6-luna. `--dangerously-skip-permissions`, so no review box takes keystrokes; `save_skill` shows its own screen in every mode. The fixture repository has six `TODO`s and one `FIXME` in three files. Keys are typed one at a time, 20 ms apart; the paste is a bracketed paste; the burst is the whole text in one write.

**Recorded before the owner's decision that hypermode pins `xhigh`.** These frames show the mode and the trigger pinning `max`, gpt-5.6-luna's highest level, as the build at `2cfed5cc` did. The build after that decision is recorded in the last section.

Specs: `tui-composer-triggers-main.json` (120x40, real model) and `tui-composer-triggers-widths.json` (80x24, 40x30 and 80x24 with `NO_COLOR=1`, no model call).

## `/effort`: the last stop

gpt-5.6-luna publishes up to `max`, and hypermode pins the highest published level, so the stop names `max`; on a menu that ends at `xhigh` it reads `xhigh + hypermode (workflows)`.

```text

                       Faster                                                              Smarter
                       ───▲──────────────────────────────────────────┆────────────────────────────
                       default   low   medium   high   xhigh   max   ┆ max + hypermode (workflows)
                                                                       Off · delegates to parallel agents by default
   
  ←/→ adjust · 1–9 select · enter apply · esc back
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · …/fixture  ←/→ adjust · 1–9 select · enter apply · esc back
```

## `/orchestrate on`: the deprecated alias

```text
 · /orchestrate is deprecated: the mode is now called hypermode. Use /hypermode; /orchestrate will be removed in a
   later major version.

 · Hypermode is on — effort pinned to max for gpt-5.6-luna, and delegation guidance is strengthened for this session.

 ┌─ MESSAGE ────────────────────────────────────────────────────────────────────────────────────────────── hypermode ─┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · effort max · hypermode · …/fixture  gpt-5.6-luna
```

## `ultracode` arms nothing

No tag row: the word is not a namzu trigger.

```text

 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ › ultracode fix the flaky test▏                                                                                    │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · effort max · …/fixture gpt-5.6-luna
```

## The Turkish request, pasted (bracketed paste): a suggestion

```text
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ✧ hypermode? · alt+w arms                                                                                          │
 │ › hypermode ile şu repodaki TODO'ları iki agent'a bölerek say▏                                                     │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · effort max · …/fixture gpt-5.6-luna
```

## The same text in one write (a paste without markers): a suggestion

```text
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ✧ hypermode? · alt+w arms                                                                                          │
 │ › hypermode ile şu repodaki TODO'ları iki agent'a bölerek say▏                                                     │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · effort max · …/fixture gpt-5.6-luna
```

## The same text typed key by key: armed

```text
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ✦ hypermode · this turn: effort max, delegate to parallel agents · alt+w drop                                      │
 │ › hypermode ile şu repodaki TODO'ları iki agent'a bölerek say▏                                                     │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · effort max · …/fixture gpt-5.6-luna
```

## Alt+W: dropped

```text
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ✧ hypermode (off) · alt+w restores                                                                                 │
 │ › hypermode ile şu repodaki TODO'ları iki agent'a bölerek say▏                                                     │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · effort max · …/fixture gpt-5.6-luna
```

## Alt+W again: restored

```text
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ✦ hypermode · this turn: effort max, delegate to parallel agents · alt+w drop                                      │
 │ › hypermode ile şu repodaki TODO'ları iki agent'a bölerek say▏                                                     │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · effort max · …/fixture gpt-5.6-luna
```

### The highlight, in the bytes the TUI wrote

Every frame drawn while the typed keyword was armed carries underline, bold and colour 117 on `hypermode` and nothing after it; the frame after Alt+W draws it plain; the frame after the second Alt+W underlines it again.

```text
offset 227000: plain  b' \x1b[1m\x1b[38;5;83m\xe2\x80\xba\x1b[39m\x1b[22m \x1b[38;5;252mhypermode'
```

## The turn: two agents, then the answer

The transcript line under the operator's message and the rail are scrolled off here; the settle line names the two agents.

```text
 ✓ Count TODOs in docs and app · 16s · 29.3k tokens · ctrl+o result · ctrl+t details

 ✓ Count TODOs in config and util · 18s · 29.2k tokens · ctrl+o result · ctrl+t details

 ∴ Agentların raporlarını kaynak dosyalardaki gerçek içerikle doğrulayıp toplamı kesinleştiriyorum; ardından görevi
   kapatacağım.

 Explored
 └ Read docs/notes.md · ctrl+o output
 └ Read src/app.ts · ctrl+o output
 └ Read namzu.config.json · ctrl+o output
 └ Read src/util.ts · ctrl+o output

 ✓ Completed · Count TODOs across two agent partitions
   ✓ Count TODOs across two agent partitions

 ∴ İki agent’a bölerek saydım ve kaynak dosyalarla doğruladım:

   • Agent 1
   • docs/notes.md: 2 — satır 3, 4
   • src/app.ts: 3 — satır 1, 3, 6
   • Ara toplam: 5
   • Agent 2
   • namzu.config.json: 0
   • src/util.ts: 1 — satır 1
   • Ara toplam: 1

   Toplam: 6 adet TODO. FIXME satırı hesaba katılmadı.

 ✻ Worked for 1m36s · 2 agents · 58.5k tokens

 ✻ That took 9 steps across 4 tools. Save it as a reusable skill? /skills save [name] · /skills save off to stop
   suggesting

 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · effort max · …/fixture gpt-5.6-luna
```

### Right after Enter

```text

 ⚠ Auto-approve tools — tools run without asking. Use /permissions to change this.

 · Connected to OpenAI (Codex subscription) · gpt-5.6-sol

 · Computer use is unavailable on this device: Win32Adapter: neither PowerShell Core nor Windows PowerShell is
   available on PATH

 · Model requested: gpt-5.6-luna. Checking available catalogues…

 · Computer use is unavailable on this device: Win32Adapter: neither PowerShell Core nor Windows PowerShell is
   available on PATH

 · Switched to codex · gpt-5.6-luna for this conversation.

 · /orchestrate is deprecated: the mode is now called hypermode. Use /hypermode; /orchestrate will be removed in a
   later major version.

 · Hypermode is on — effort pinned to max for gpt-5.6-luna, and delegation guidance is strengthened for this session.

 · Hypermode is off.

 › hypermode ile şu repodaki TODO'ları iki agent'a bölerek say

 ✦ hypermode (this turn, effort max)
 Working (7.9s · ↓ 12 tokens · esc to interrupt)
   └ thinking · **Discovering repo structure for delegation**

 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · effort max · …/fixture gpt-5.6-luna
```

### Mid-turn: one phase, two agents launched together

```text
 · /orchestrate is deprecated: the mode is now called hypermode. Use /hypermode; /orchestrate will be removed in a
   later major version.

 · Hypermode is on — effort pinned to max for gpt-5.6-luna, and delegation guidance is strengthened for this session.

 · Hypermode is off.

 › hypermode ile şu repodaki TODO'ları iki agent'a bölerek say

 ✦ hypermode (this turn, effort max)

 ∴ Repodaki dosya kapsamını çıkarıp iki bağımsız agent’a paylaştıracağım; ardından sonuçları birleştirip toplamı
   doğrulayacağım.

 ✓ Bash(git status --short && printf '\n--- files ---\n' && git ls-files) · 0.0s
 ⎿ --- files ---
  ▏ docs/notes.md
  ▏ namzu.config.json
  ▏ src/app.ts
  ▏ src/util.ts

 ✓ Tasks · 0/1 done
   ■ Count TODOs across two agent partitions

 ● Launched Count TODOs in docs and app · TODO audit / Parallel count (ctrl+t to manage)

 ● Launched Count TODOs in config and util · TODO audit / Parallel count (ctrl+t to manage)
 Working (49s · ↓ 1.9k tokens · esc to interrupt)

 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
```

## `bunu skill olarak kaydet` after the task: the tag row

```text
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ✦ save as skill · runs /skills save · alt+w drop                                                                   │
 │ › bunu skill olarak kaydet▏                                                                                        │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · effort max · …/fixture gpt-5.6-luna
```

## The resulting save_skill screen

```text
 Waiting for you · the question below
 ╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
 │ ✎ Save skill "iki-agent-todo-sayimi"? PROPOSED BY THE MODEL — a skill is read by every later session that loads it │
 │ .                                                                                                                  │
 │ Origin learned · session 01a0d330-f503-77d0-b61b-f52823a8c84f                                                      │
 │ User     <scratch> │
 │ <scratch>/home/skills/iki-agent-todo-sayimi/SKILL.md  (suggested)                             │
 │ Project  ./.namzu/skills/iki-agent-todo-sayimi/SKILL.md                                                            │
 │ SKILL.md, exactly as it will be written (lines 1–25 of 59)                                                         │
 │ │ ---                                                                                                              │
 │ │ name: iki-agent-todo-sayimi                                                                                      │
 │ │ description: "Kullanıcı bir depodaki TODO’ları iki agent’a bölerek saymayı istediğinde kullan. Dosyaları iki çak │
 │ ┆ ışmayan bölüme ayırır, iki bağımsız agent’tan sayım alır ve toplamı kaynak dosyalarla doğrulayarak raporlar."    │
 │ │ metadata:                                                                                                        │
 │ │   namzu-origin: learned                                                                                          │
 │ │   namzu-session: "01a0d330-f503-77d0-b61b-f52823a8c84f"                                                          │
 │ │   namzu-created: "2026-09-24T11:40:18.859Z"                                                                      │
 │ │ ---                                                                                                              │
 │ │                                                                                                                  │
 │ │ # İki agent ile TODO sayımı                                                                                      │
 │ │                                                                                                                  │
 │ │ Bir depodaki TODO işaretlerini iki bağımsız agent’a paylaştırarak say, sonra sonuçları yerel dosya içeriğiyle do │
 │ ┆ ğrula.                                                                                                           │
 │ │                                                                                                                  │
 │ │ 1. **Kapsamı belirle.**                                                                                          │
 │ │    - `<repo-kökü>` içindeki izlenen veya kullanıcının belirttiği dosyaları read-only araçlarla listele.          │
 │ │    - Dosyaları iki çakışmayan bölüme ayır: `<bölüm-A>` ve `<bölüm-B>`. Her dosya tam olarak bir bölümde yer alma │
 │ ┆ lı.                                                                                                              │
 │ │    - Kullanıcı başka bir kural vermediyse, büyük/küçük harfe duyarlı literal `TODO` metinlerini say. Yorum, stri │
 │ ┆ ng, belge ve yapılandırma dosyalarındaki eşleşmeleri dahil et; `FIXME` veya küçük harfli `todo` gibi farklı meti │
 │ ┆ nleri dahil etme.                                                                                                │
 │ │    - Sayım kuralı belirsizse, kullanılan kuralı sonuçta açıkça belirt.                                           │
 │ │                                                                                                                  │
 │ │ 2. **İki agent’a böl.**                                                                                          │
 │                                                                                                                    │
 │  1 Save to user    2 Save to project    3 Cancel                                                                   │
 │ ←/→ choose · enter apply · ↑/↓ PgUp/PgDn scroll · esc cancel                                                       │
 ╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · effort max · …/fixture save skill — ←/→ choose · enter apply · esc cancel
```

## Esc: nothing saved

No `SKILL.md` was written in the user or project skills directory. The model then asked what to change, as `/skills save` asks it to on a cancel; that question card took the scripted `/exit`, and the driver stopped the process.

```text

 ✓ Read skill skill-creator · 0.0s

 ○ Propose skill iki-agent-todo-sayimi · 4.1s
 ⎿ Cancelled — nothing was saved
 Waiting for you · the question below
 ┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ İptal edilen skill taslağında neyi değiştirmemi istersin?                                                      1/4 │
 │ Skill değişikliği · Enter answers · Esc skips                                                                      │
 │ ›1. Adımlar ve doğrulama (Recommended) Agent’ların bölümlendirilmesi, sayım kuralı veya kaynakla doğrulama akışın… │
 │  2. İsim ve tetikleyici                Skill adını ya da hangi kullanıcı isteklerinde kullanılacağını değiştirir.  │
 │  3. Kapsam ve ayrıntı                  User/project kapsamını veya raporlama ayrıntılarını değiştirir.             │
 │  4. Something else…                    Answer in your own words                                                    │
 │ ↑↓ navigate · PgUp/PgDn jump · Home/End · 1–9 select · enter apply · esc back                                      │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · effort max · …/fixture           ↑↓ / 1–9 select · enter apply · esc back
```

## w80x24: typed-armed

```text
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────┐
 │ ✦ hypermode · this turn, effort ultra · alt+w                              │
 │ › hypermode ile şu repodaki TODO'ları iki agent'a bölerek say▏             │
 └────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · …/fixture             gpt-5.6-sol
```

## w80x24: alt-w-dropped

```text
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────┐
 │ ✧ hypermode (off) · alt+w restores                                         │
 │ › hypermode ile şu repodaki TODO'ları iki agent'a bölerek say▏             │
 └────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · …/fixture             gpt-5.6-sol
```

## w80x24: save-embedded

```text
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────┐
 │ ✦ save as skill · after this turn · alt+w                                  │
 │ › fix the tests, then save it as a skill▏                                  │
 └────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · …/fixture             gpt-5.6-sol
```

## w80x24: question

```text
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────┐
 │ ✧ hypermode? · alt+w arms                                                  │
 │ › what is hypermode?▏                                                      │
 └────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · …/fixture             gpt-5.6-sol
```

## w40x30: typed-armed

```text
 ┌─ MESSAGE ──────────────────────────┐
 │ ✦ hypermode                        │
 │ › hypermode ile şu repodaki        │
 │   TODO'ları iki agent'a bölerek    │
 │   say▏                             │
 └────────────────────────────────────┘
 ⏵⏵ Auto-approve tools      gpt-5.6-sol
```

## w40x30: alt-w-dropped

```text
 ┌─ MESSAGE ──────────────────────────┐
 │ ✧ hypermode (off)                  │
 │ › hypermode ile şu repodaki        │
 │   TODO'ları iki agent'a bölerek    │
 │   say▏                             │
 └────────────────────────────────────┘
 ⏵⏵ Auto-approve tools      gpt-5.6-sol
```

## w40x30: save-embedded

```text

 ┌─ MESSAGE ──────────────────────────┐
 │ ✦ save as skill                    │
 │ › fix the tests, then save it as a │
 │    skill▏                          │
 └────────────────────────────────────┘
 ⏵⏵ Auto-approve tools      gpt-5.6-sol
```

## w40x30: question

```text
   PowerShell is available on PATH

 ┌─ MESSAGE ──────────────────────────┐
 │ ✧ hypermode?                       │
 │ › what is hypermode?▏              │
 └────────────────────────────────────┘
 ⏵⏵ Auto-approve tools      gpt-5.6-sol
```

## nocolor: typed-armed

```text
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────┐
 │ ✦ hypermode · this turn, effort ultra · alt+w                              │
 │ › hypermode ile şu repodaki TODO'ları iki agent'a bölerek say▏             │
 └────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · …/fixture             gpt-5.6-sol
```

## nocolor: alt-w-dropped

```text
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────┐
 │ ✧ hypermode (off) · alt+w restores                                         │
 │ › hypermode ile şu repodaki TODO'ları iki agent'a bölerek say▏             │
 └────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · …/fixture             gpt-5.6-sol
```

## nocolor: save-embedded

```text
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────┐
 │ ✦ save as skill · after this turn · alt+w                                  │
 │ › fix the tests, then save it as a skill▏                                  │
 └────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · …/fixture             gpt-5.6-sol
```

## nocolor: question

```text
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────┐
 │ ✧ hypermode? · alt+w arms                                                  │
 │ › what is hypermode?▏                                                      │
 └────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · …/fixture             gpt-5.6-sol
```

## After the owner's decision: hypermode pins `xhigh`

The merged build (feature branch at `3156620d` merged with `origin/main` at `791e949c`), same driver, fresh `NAMZU_HOME`, `/model gpt-5.6-luna`, no model call (spec `tui-composer-triggers-xhigh.json`). gpt-5.6-luna publishes `max`; the mode and the keyword pin `xhigh`.

### `/effort`

```text

                      Faster                                                                Smarter
                      ───▲──────────────────────────────────────────┆──────────────────────────────
                      default   low   medium   high   xhigh   max   ┆ xhigh + hypermode (workflows)
                                                                      Off · delegates to parallel agents by default
   
  ←/→ adjust · 1–9 select · enter apply · esc back
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · …/fixture  ←/→ adjust · 1–9 select · enter apply · esc back
```

### `/hypermode on`

```text
 · Hypermode is on — effort pinned to xhigh for gpt-5.6-luna, and delegation guidance is strengthened for this session.

 ┌─ MESSAGE ────────────────────────────────────────────────────────────────────────────────────────────── hypermode ─┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · effort xhigh · hypermode · …/fixture           gpt-5.6-luna
```

### `/hypermode off`

```text

 · Hypermode is off — effort back to the provider default.

 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · …/fixture gpt-5.6-luna
```

### The keyword, typed

```text
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ✦ hypermode · this turn: effort xhigh, delegate to parallel agents · alt+w drop                                    │
 │ › hypermode fix the flaky test▏                                                                                    │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve tools (shift+tab to cycle) · …/fixture gpt-5.6-luna
```
