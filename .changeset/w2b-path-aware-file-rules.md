---
'@namzu/cli': major
---

A permission pattern under `read`, `edit`, `write`, `grep`, `glob` or `ls` is now a path, resolved against the working folder (`./` or a bare name), the project folder (`/`), your home folder (`~/`) or the filesystem root (`//`). Before, it was matched against the call's serialised input, so `*.ts` matched a `.ts` file in any folder and `*/.env` matched `.env` anywhere; now `*` stays inside one folder and `**` crosses folders. To keep the old reach, write `**/*.ts` and `**/.env`. A rule on a folder covers its contents, links are followed, a rule on `edit` also decides `write`, and a rule on `read` also decides `grep`, `glob` and `ls`. `Read(./.env)` in the list form is kept as written and means that file in the working folder. A bare `*` still means every call.
