---
okf_version: "0.2"
---

# Namzu documentation

This directory is an [OKF v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) knowledge bundle: every page is a concept with YAML frontmatter, each directory carries an `index.md`, and `log.md` records what changed.

# Sections

* [cli](cli/) - The operator application: commands, configuration, and its doctor.
* [conventions](conventions/) - Ratified rules about how code is written here, each with the incident that produced it.
* [packages](packages/) - The optional capability packages that ship beside the kernel.
* [providers](providers/) - One driver package per model service, and how each is configured.
* [sdk](sdk/) - The kernel: architecture, runtime contracts, tools, observability, and integrations.
