FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bin ./bin
COPY src ./src
COPY docs ./docs
ENV PORT=8790 OPENMCP_DB=/data/openmcp.db NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8790
CMD ["node", "bin/openmcp.mjs", "serve"]
