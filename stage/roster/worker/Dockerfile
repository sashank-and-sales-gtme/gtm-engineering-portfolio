# The roster's API research worker. Build from the repository root so the agent prompts are included:
#   docker build -f roster/worker/Dockerfile -t roster-worker .
#   docker run -e ROSTER_WORKER_URL=... -e ROSTER_WORKER_TOKEN=... -e ANTHROPIC_API_KEY=... roster-worker
FROM node:22-slim
WORKDIR /app/roster/worker
COPY roster/worker/package.json roster/worker/package-lock.json ./
RUN npm ci --omit=dev
COPY roster/worker/ ./
COPY .claude/agents /app/.claude/agents
USER node
CMD ["node", "api-worker.mjs", "--loop"]
