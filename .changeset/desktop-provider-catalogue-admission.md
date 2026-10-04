---
"@namzu/cli": patch
---

Show only the provider's actual listed model rows in the desktop catalogue.
Do not insert unavailable registry defaults or saved models as available
choices. Keep the current route visible in provider status and report omitted,
failed, unsupported and timed-out catalogues with explicit notices. Credential
rejections receive a safe authentication notice without remote diagnostics.
Recognize a typed rejected subscription refresh grant as an authentication
failure while keeping TLS and network failures distinct from invalid credentials.
Use the driver's strict account listing when provided instead of mistaking a
bundled fallback for a live account catalogue.

Check the selected model's credential access and supported wire before closing
the previous conversation session. An invalid anonymous Zen switch now leaves
the previous session intact, and a new conversation can select an eligible free
model before preparing an unavailable saved provider.

Fix model preparation on a newly created ordinary ACP conversation before its
first journal exists. Authorize only a session actually published on the same
connection with the exact canonical workspace; unknown IDs, foreign workspaces
and stopped slots remain refused. Pal conversations still require their durable
ownership claim.
