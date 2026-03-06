# Stage 1: build native dependencies
FROM node:20-alpine AS build

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: runtime
FROM node:20-alpine

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json config.example.yml ./
COPY src/ ./src/
COPY seed/ ./seed/
COPY models/ ./models/
COPY knowledge/ ./knowledge/
COPY bin/ ./bin/

ENV ATLAS_DB_PATH=/data/atlas/atlas.db
ENV ATLAS_PORT=3000

RUN mkdir -p /data/atlas /app/knowledge /app/inbox \
 && addgroup -S atlas && adduser -S atlas -G atlas \
 && chown -R atlas:atlas /app /data/atlas

USER atlas

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)throw r;process.exit(0)}).catch(()=>process.exit(1))"

CMD ["node", "src/ui-server.js"]
