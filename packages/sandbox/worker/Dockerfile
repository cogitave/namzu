# =============================================================================
# @namzu/sandbox container-backend reference image
# =============================================================================
# Universal local-dev / single-tenant prod default for the
# `container:docker` tier. Everything Claude / GPT / etc. plausibly
# need to produce a deliverable from a freshly-spawned task lives
# inside the image; the host's only job is to spawn the container,
# proxy egress, and tear down on `destroy()`.
#
# Hosts that want a leaner image build their own and reference it
# via `ContainerBackendConfig.image`. The fat default exists so a
# greenfield namzu deployment "just works" against the typical
# agent workload (DOCX/XLSX/PPTX/PDF generation, data wrangling,
# OCR, charting, browser automation).
#
# Distro choice:
#   - Debian Bookworm slim, not Alpine. python-docx / openpyxl /
#     reportlab / pillow / weasyprint all have C extensions that
#     prefer glibc; Alpine + musl produces hard-to-debug failures
#     in the doc-gen pipeline (compass-platform hit this).
#   - python3 + apt is the path with the broadest binary-wheel
#     coverage (manylinux2014 on glibc).
#
# Trust model:
#   - Container is the trust boundary; host treats process inside
#     as untrusted code. Worker listens on 127.0.0.1 only; outbound
#     network goes through the egress proxy (P3.2).
#   - Non-root user (`namzu:1001`) for the worker process. Host
#     mounts `/workspace` writable to that uid.
# =============================================================================

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_ENV=production

# ─── System packages ─────────────────────────────────────────────
# Group 1: shell, build basics, network tools the model commonly reaches for.
# Group 2: document toolchain (LibreOffice, pandoc, Ghostscript, qpdf).
# Group 3: PDF / OCR / image tooling (poppler, tesseract w/ Turkish, ImageMagick).
# Group 4: charting / diagram (graphviz), browser automation (chromium + nss).
# Group 5: scientific / data prerequisites for python wheels (gfortran,
#          libopenblas, libfreetype, libpango, libcairo, libgdk-pixbuf, librsvg).
# Group 6: fonts — Noto (CJK + emoji), Liberation, DejaVu, FreeFont, Turkish-friendly.
# Group 7: text search (ripgrep), structured tools (jq, yq), parallelism (xargs from coreutils).

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl wget git unzip zip xz-utils ca-certificates dumb-init tini \
        make build-essential pkg-config gnupg2 gosu \
    libreoffice libreoffice-impress libreoffice-writer libreoffice-calc \
        pandoc ghostscript qpdf \
    poppler-utils tesseract-ocr tesseract-ocr-tur tesseract-ocr-eng \
        imagemagick exiftool optipng jpegoptim \
    graphviz \
        chromium chromium-driver libnss3 libatk-bridge2.0-0 libxss1 \
        libxshmfence1 libgbm1 libasound2 \
    python3 python3-pip python3-venv python3-dev \
        libopenblas-dev liblapack-dev gfortran \
        libfreetype6-dev libpng-dev libjpeg-dev libtiff-dev libwebp-dev \
        libxml2-dev libxslt1-dev \
        libcairo2-dev libpango1.0-dev libgdk-pixbuf2.0-dev librsvg2-bin \
        libffi-dev libssl-dev zlib1g-dev \
    fonts-noto fonts-noto-cjk fonts-noto-color-emoji \
        fonts-liberation fonts-dejavu fonts-freefont-ttf fonts-symbola \
        fontconfig \
    ripgrep jq yq tree htop procps \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# ─── Python data + doc-gen + analytics + ML stack ─────────────
# Pinned to recent stable versions. `--break-system-packages` because
# Debian 12's PEP 668 marks the system Python as externally managed;
# this is a single-purpose container, not a long-lived OS install.

RUN pip3 install --break-system-packages --no-cache-dir \
    # Office document IO
    openpyxl==3.1.5 xlsxwriter==3.2.0 python-docx==1.1.2 python-pptx==1.0.2 \
    pypdf==5.0.1 reportlab==4.2.5 pdfplumber==0.11.4 pymupdf==1.24.10 \
    pdf2image==1.17.0 docx2pdf==0.1.8 \
    # PDF / HTML rendering
    weasyprint==65.1 pydyf==0.11.0 markdown==3.7 jinja2==3.1.4 \
    beautifulsoup4==4.12.3 lxml==5.3.0 html5lib==1.1 \
    # Data wrangling
    pandas==2.2.3 polars==1.12.0 numpy==1.26.4 pyarrow==17.0.0 \
    duckdb==1.1.2 sqlalchemy==2.0.36 \
    openpyxl-stubs==0.1.25 \
    # Charting
    matplotlib==3.9.2 plotly==5.24.1 seaborn==0.13.2 kaleido==0.2.1 \
    # ML / stats baseline
    scikit-learn==1.5.2 statsmodels==0.14.4 scipy==1.14.1 \
    # OCR + image
    pytesseract==0.3.13 Pillow==10.4.0 opencv-python-headless==4.10.0.84 \
    # OR / planning / forecasting (compass parity)
    ortools==9.11.4210 pulp==2.9.0 simpy==4.1.1 networkx==3.4.2 workalendar==17.0.0 \
    # HTTP / API
    requests==2.32.3 httpx==0.27.2 aiohttp==3.10.10 \
    # Misc utilities the model reaches for
    qrcode==8.0 PyYAML==6.0.2 python-dotenv==1.0.1 click==8.1.7 rich==13.9.4 \
    tqdm==4.67.0 markdown-it-py==3.0.0 typer==0.13.0

# ─── Node-based document toolchain ─────────────────────────────
# Mermaid for diagrams; xlsx/docx/pptxgenjs/pdf-lib for JS-side
# generation; markdown-it / dompurify for safe markdown rendering;
# puppeteer skips its own Chromium since we pinned the system one.

RUN npm install -g --omit=optional --no-audit --no-fund \
    @mermaid-js/mermaid-cli@11.4.0 \
    xlsx@0.18.5 \
    docx@9.0.2 \
    pptxgenjs@3.12.0 \
    pdf-lib@1.17.1 \
    sharp@0.33.5 \
    markdown-it@14.1.0 \
    dompurify@3.1.7 jsdom@25.0.1

# ─── Sanity check ───────────────────────────────────────────────
# Fail the build if any critical pre-install is missing or broken.
# Quicker to catch here than to discover at task time.

RUN python3 -c "import openpyxl, docx, pptx, pypdf, reportlab, PIL, \
    pdfplumber, pytesseract, jinja2, markdown, bs4, qrcode, weasyprint, \
    pandas, numpy, pyarrow, duckdb, matplotlib, plotly, sklearn, ortools, \
    requests, httpx; print('python deps OK')" \
    && libreoffice --version \
    && pandoc --version | head -1 \
    && chromium --version \
    && tesseract --version 2>&1 | head -1 \
    && node -e "require('xlsx'); require('docx'); require('pptxgenjs'); require('pdf-lib'); console.log('node deps OK')"

# ─── Workspace + non-root user ─────────────────────────────────

RUN groupadd --system --gid 1001 namzu \
    && useradd --system --uid 1001 --gid namzu --create-home namzu \
    && mkdir -p /workspace \
    && chown -R namzu:namzu /workspace

WORKDIR /workspace

# ─── Worker ─────────────────────────────────────────────────────

COPY --chown=namzu:namzu worker/server.js /opt/namzu-sandbox/server.js

USER namzu

ENV NAMZU_SANDBOX_WORKSPACE=/workspace \
    NAMZU_SANDBOX_PORT=2024

EXPOSE 2024

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "/opt/namzu-sandbox/server.js"]
