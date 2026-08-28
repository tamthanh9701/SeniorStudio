FROM mcr.microsoft.com/playwright:v1.62.1-noble
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends xvfb fluxbox x11vnc novnc websockify && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY bridge/package.json bridge/package.json
RUN pnpm install --frozen-lockfile
COPY bridge bridge
RUN chmod +x bridge/entrypoint.sh
ENV NODE_ENV=production
EXPOSE 6080 8787
ENTRYPOINT ["/app/bridge/entrypoint.sh"]
