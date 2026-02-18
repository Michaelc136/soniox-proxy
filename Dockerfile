FROM node:20-alpine

# Cache buster - change this value to force rebuild
ARG CACHE_BUST=2026-02-18-security-v5-deploy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (use npm install if no lock file, ci if available)
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy source code
COPY server.js ./

# Expose port (DigitalOcean will set PORT env var)
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-8080}/health || exit 1

# Start the server
CMD ["node", "server.js"]
