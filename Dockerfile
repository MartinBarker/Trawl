FROM node:20-alpine

# Add non-root user for security
RUN addgroup -S botgroup && adduser -S botuser -G botgroup

WORKDIR /app

# Copy dependency files first (better layer caching)
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy application source
COPY start_discord_bot.js ./
COPY deploy_discord_commands.js ./
COPY youtube-sync-scheduler.js ./
COPY commands/ ./commands/
COPY db/ ./db/
COPY lib/ ./lib/
COPY api/ ./api/

# Create data directory for any runtime files (JSON exports, tokens)
RUN mkdir -p /app/data && chown -R botuser:botgroup /app/data

# Switch to non-root user
USER botuser

EXPOSE 3000

# Health check — the Express API must answer on /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "start_discord_bot.js"]
