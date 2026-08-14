# ==============================================================================
# DEARBACKUP DOCKERFILE - MULTI-STAGE OPTIMIZADO (NODE 22 LTS)
# ==============================================================================

# 1. Etapa de Compilación
FROM node:22-alpine AS builder

WORKDIR /app

# Instalar dependencias de compilación para módulos nativos C++ (better-sqlite3)
RUN apk add --no-cache python3 make g++ gcc sqlite-dev

# Instalar todas las dependencias
COPY package*.json tsconfig.json ./
RUN npm install

# Copiar código fuente y compilar TypeScript y frontend
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Eliminar dependencias de desarrollo para dejar solo las de producción en /app/node_modules
RUN npm prune --omit=dev


# 2. Etapa de Producción (Ultra ligera y rápida)
FROM node:22-alpine

WORKDIR /app

# Instalar utilidades esenciales de sistema para respaldos remotos, DB y SSH
RUN apk add --no-cache \
    openssh-client \
    mariadb-client \
    postgresql-client \
    tar \
    gzip \
    openssl \
    ca-certificates \
    tzdata \
    sqlite

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV BACKUPS_DIR=/app/backups

# Copiar node_modules ya compilados desde el builder (cero necesidad de gyp/python en producción)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist

# Crear directorios para volúmenes persistentes
RUN mkdir -p /app/data /app/backups

EXPOSE 3000

VOLUME ["/app/data", "/app/backups"]

CMD ["node", "dist/index.js"]
