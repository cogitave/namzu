---
'@namzu/sandbox': minor
---

feat(sandbox): `container:docker` backend implementation

P3.1 — first concrete backend lands. `createSandboxProvider({ backend: { tier: 'container', runtime: 'docker', image } })` now returns a working `SandboxProvider`:

- Spawns one Docker container per `Sandbox` instance via the `docker` CLI (no node-docker SDK dep — keeps the package thin).
- Container runs the small HTTP worker shipped under `packages/sandbox/worker/server.js`. The host adapter talks to it on `127.0.0.1:<random-port>`.
- Worker exposes `/healthz` (liveness), `/execute` (NDJSON-streamed command run), `/read-file`, `/write-file`. All `Sandbox` interface methods route through these.
- Container goes away on `Sandbox.destroy()` (`docker rm -f`).
- Workspace bind-mount under `/tmp/namzu-sandbox-<id>-*` cleaned up on destroy.
- Resource caps from `SandboxBackendOptions` map to Docker flags: `memoryLimitMb` → `--memory`, `maxProcesses` → `--pids-limit`. Default network is `none` (egress proxy plumbing is P3.2).

Reference Dockerfile (`packages/sandbox/worker/Dockerfile`) ships with a comprehensive pre-installed toolchain so a greenfield namzu deployment "just works" against the typical agent workload:

- **Office IO**: openpyxl, xlsxwriter, python-docx, python-pptx, pypdf, reportlab, pdfplumber, pymupdf, pdf2image, docx2pdf.
- **Rendering**: weasyprint, pydyf, markdown, jinja2, beautifulsoup4, lxml, html5lib.
- **Data**: pandas, polars, numpy, pyarrow, duckdb, sqlalchemy.
- **Charting**: matplotlib, plotly, seaborn, kaleido.
- **ML / stats**: scikit-learn, statsmodels, scipy.
- **OCR / image**: pytesseract, Pillow, opencv-python-headless.
- **OR / planning**: ortools, pulp, simpy, networkx, workalendar.
- **HTTP**: requests, httpx, aiohttp.
- **System tools**: LibreOffice, pandoc, Ghostscript, qpdf, poppler-utils, tesseract (eng+tur), ImageMagick, exiftool, optipng, jpegoptim, graphviz, Chromium (+ chromium-driver), ripgrep, jq, yq, tree, htop.
- **Node toolchain**: `@mermaid-js/mermaid-cli`, xlsx, docx, pptxgenjs, pdf-lib, sharp, markdown-it, dompurify, jsdom.
- **Fonts**: Noto (Latin + CJK + emoji + symbol), Liberation, DejaVu, FreeFont — Turkish-friendly.
- **Distro**: Debian Bookworm slim, not Alpine — manylinux wheel coverage matters for the doc-gen path; compass-platform hit musl issues on the same workload.

Hosts that want a leaner image build their own and reference it via `ContainerBackendConfig.image`. The fat default exists so the agent isn't told to use a tool that doesn't exist (the prompt-vs-runtime drift class of bugs Codex flagged repeatedly in the Vandal Cowork iterations).

Trust model: container is the trust boundary; worker listens on loopback inside its own netns; outbound network defaults to `none` until the egress proxy lands in P3.2. Worker runs as non-root (`namzu:1001`) inside the container; host mounts `/workspace` writable to that uid.
