FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY src ./src

RUN printf '%s\n' '#!/bin/sh' 'exec node --import tsx /app/src/v2/agent-runner/cli.ts "$@"' > /usr/local/bin/southstar-agent-runner \
  && chmod +x /usr/local/bin/southstar-agent-runner
RUN mkdir -p /tmp/pi-agent-sessions && chmod 1777 /tmp/pi-agent-sessions

ENV NODE_ENV=production
ENV SOUTHSTAR_CONTAINER_IMAGE=southstar/pi-agent:local

ENTRYPOINT ["southstar-agent-runner"]
