# test/lab/Dockerfile — the Anagram test lab: a Linux box with its own screen.
#
# Everything a test run opens (Chromium windows, the extension, the test native host) lives on a
# virtual X display INSIDE this container. Nothing is launched on the Mac, so nothing can
# take focus, move the pointer or land in the Dock. The display is published as one web page
# (noVNC) that you park on a desktop of its own and glance at when you want to.
#
# Built and driven by scripts/lab.mjs (npm run lab …) — do not run this by hand.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# The screen: X + VNC server in one (TigerVNC), a small window manager, the web viewer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tigervnc-standalone-server tigervnc-tools novnc websockify fluxbox \
      rsync procps curl ca-certificates scrot x11-utils x11-xserver-utils xdotool \
 && rm -rf /var/lib/apt/lists/*

# The browser: exactly the Chromium build the repo's Playwright version drives, plus the
# system libraries and fonts it needs. Keyed on the version alone, so editing the lockfile
# does not download a browser again. PLAYWRIGHT_DOWNLOAD_HOST selects a mirror of the
# browser builds (scripts/lab.mjs picks one only when the official CDN is unreachable).
ARG PLAYWRIGHT_VERSION
ARG PLAYWRIGHT_DOWNLOAD_HOST=
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
LABEL anagram.lab.download-host="${PLAYWRIGHT_DOWNLOAD_HOST}"
RUN apt-get update \
 && PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST}" npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

# Dependencies are part of the image (Linux binaries for esbuild/rollup live here, never in
# the Mac's node_modules). The layer is keyed on the lockfile, so it rebuilds only when the
# lockfile changes. --ignore-scripts: postinstall needs the sources, which arrive at sync.
WORKDIR /work
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && sha256sum package-lock.json | cut -d' ' -f1 > /work/.lab-lock \
 && mkdir -p /out && chown -R node:node /work /out && rm -rf /root/.npm

COPY --chmod=755 test/lab/entrypoint.sh /usr/local/bin/lab-entrypoint
USER node
ENV DISPLAY=:99 HOME=/home/node
EXPOSE 6080
ENTRYPOINT ["/usr/local/bin/lab-entrypoint"]
