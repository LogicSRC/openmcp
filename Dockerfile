# Debian, not Alpine: the Obscura binary needs glibc 2.35 or later.
FROM node:24-bookworm-slim
ARG OBSCURA_VERSION=0.2.2
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL "https://github.com/h4ckf0r0day/obscura/releases/download/v${OBSCURA_VERSION}/obscura-x86_64-linux-stealth.tar.gz" \
     | tar -xz -C /usr/local/bin obscura obscura-worker \
  && chmod +x /usr/local/bin/obscura /usr/local/bin/obscura-worker \
  && /usr/local/bin/obscura --version \
  && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bin ./bin
COPY src ./src
COPY docs ./docs
ENV PORT=8790 OPENMCP_DB=/data/openmcp.db NODE_ENV=production OBSCURA_BIN=/usr/local/bin/obscura
VOLUME ["/data"]
EXPOSE 8790
CMD ["node", "bin/openmcp.mjs", "serve"]
