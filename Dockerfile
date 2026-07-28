FROM node:22-alpine AS base
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

# Build stage: needs dev dependencies (vite, typescript) to compile the app.
# prisma/ must be present before `npm ci` — the postinstall hook runs `prisma generate`.
FROM base AS build
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --include=dev && npm cache clean --force
COPY . .
RUN npm run build

# Production dependencies only
FROM base AS prod-deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

# Runtime image: prod node_modules + built server, nothing else
FROM base
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY --from=build /app/build ./build

EXPOSE 3000

# docker-start = prisma generate + prisma migrate deploy + remix-serve
CMD ["npm", "run", "docker-start"]
