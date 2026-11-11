# The hosted MCP service: Bun plus the tm catalog; build context is the repository root.
FROM oven/bun:1.4.3-alpine
WORKDIR /app
COPY package.json bun.lock ./
COPY clients/tm/package.json clients/tm/package.json
# Not --production: tm reads clients/tm/package.json at run time and expects a full install.
RUN bun install --frozen-lockfile
COPY clients/tm/src clients/tm/src
COPY services/mcp services/mcp
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
USER bun
CMD ["bun", "services/mcp/main.ts"]
