---
'@namzu/zen': major
'@namzu/cli': major
---

Zen Go no longer includes `glm-5.1`, `qwen3.6-plus`, or `qwen3.7-max` in its bundled supported model roster. The service still lists these IDs, but its current documentation provides no route or price for them. Applications relying on these IDs should select a documented model or, if they have independently verified the wire, configure `ZenGoProvider` with an explicit `protocol`. The CLI no longer offers these reviewed omissions.

The default anonymous Zen model changes from `muse-spark-1.3-contributor-free` to `space-bunny-free` in both the SDK and CLI. Callers that need the old choice must pass `model: 'muse-spark-1.3-contributor-free'` explicitly and try credentialed Zen access, subject to gateway admission. The gateway currently rejects direct keyless Namzu requests to Muse and six other documented free models with HTTP 403; only Space Bunny Free completed a live keyless text and tool-continuation test. Anonymous model discovery now admits only that verified model while retaining the other free models for credentialed use.

Zen and Zen Go now follow the reference client's route overrides for DeepSeek V4 Flash and MiniMax, handle Muse Spark reasoning continuation without replaying gateway-bound ciphertext, and read the current Zen Go price table when refreshing the catalogue. These keyed routes have wire-fixture coverage but were not live-tested with an account. The CLI distinguishes model listing from verified inference and explains the gateway's specific HTTP 403 free-tier refusal.
