FROM node:24-bookworm-slim

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    wget \
    git \
    git-lfs \
    gh \
    openssh-client \
    jq \
    ripgrep \
    python3 \
    python3-pip \
    python3-venv \
    make \
    gcc \
    g++ \
    pkg-config \
    patch \
    tar \
    unzip \
    zip \
    rsync \
  && git lfs install --system \
  && npm install -g pnpm \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
RUN ln -s /app/node_modules/.bin/playwright-cli /usr/local/bin/playwright-cli
RUN node /app/node_modules/@playwright/cli/node_modules/playwright/cli.js install-deps chromium
RUN playwright-cli install-browser chromium \
  && chmod -R 755 /ms-playwright \
  && rm -rf /var/lib/apt/lists/*

COPY src ./src

RUN printf '%s\n' '#!/bin/sh' 'exec node --import tsx /app/src/v2/agent-runner/cli.ts "$@"' > /usr/local/bin/southstar-agent-runner \
  && chmod +x /usr/local/bin/southstar-agent-runner
RUN mkdir -p /tmp/pi-agent-sessions && chmod 1777 /tmp/pi-agent-sessions

ENV NODE_ENV=production
ENV SOUTHSTAR_CONTAINER_IMAGE=southstar/pi-agent:local

ENTRYPOINT ["southstar-agent-runner"]
