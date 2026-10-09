# ==========================================
# Stage 1: Build & Test
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package descriptors
COPY package*.json tsconfig*.json ./

# Install dependencies (including devDependencies for TypeScript & test runner)
RUN npm ci

# Copy source code and test files
COPY src/ ./src/
COPY test/ ./test/

# Run unit tests during container build to guarantee code health
RUN npm test

# Compile TypeScript to dist/
RUN npm run build

# ==========================================
# Stage 2: Production Runtime
# ==========================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV TRANSPORT=http

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled JavaScript from builder stage
COPY --from=builder /app/dist ./dist

# Create directory for optional physical accounts.json volume mount
RUN mkdir -p /etc/clarity && chown -R node:node /app /etc/clarity

# Run as non-privileged node user for security
USER node

EXPOSE 3000

# Health check verifies the HTTP server is responsive
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --spider -q http://localhost:3000/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
