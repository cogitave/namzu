---
'@namzu/desktop': patch
---

Namzu Desktop gains the engine for on-device voice commands: a Turkish speech-to-text model and a voice-activity detector that run in worker threads and download only when the person asks. Nothing in the interface uses it yet, so there is nothing to do on upgrade. The installer now carries the Windows x64 speech runtime (`sherpa-onnx-node`), unpacked from the app archive.
