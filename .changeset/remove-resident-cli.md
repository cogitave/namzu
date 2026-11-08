---
'@namzu/cli': major
---

Remove `namzu resident` and everything behind it. The command, its actions (`add`, `run`, `start`, `status`, `inspect`, `stop`, `release`, `pause`, `resume`, `wake`, `archive`, `reconcile`, `learn`, `learning`), the managed background runner and its worker bundle are gone, and `namzu resident` now exits 64 like any unknown command. A script that calls it must change: use `namzu schedule` for recurring work, `/goal` for work that spans turns, background agents for parallel work, and `namzu learn` / `namzu learning` for learning (they are the same commands `namzu resident learn` and `namzu resident learning` were).

State an earlier version saved for residents stays on disk under `projects/<project>/residents/`; this version neither reads nor deletes it, except for the learning target described next. A resident runner process started by an earlier version is not stopped by this upgrade; stop it with that version before upgrading.

Learning data carries over. A learning target an earlier version used (`projects/<project>/residents/<name>/`, with its experiment journal, artifacts and guidance) is copied into `projects/<project>/learning/targets/<name>/` the first time `namzu learn <module> --agent <name>` uses it. The old files are left in place and the journal and guidance history are the same. `namzu learning` on a target that does not exist yet says no experiments are recorded and creates nothing.
