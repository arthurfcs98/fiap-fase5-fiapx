# =============================================================================
# Dockerfile ÚNICO e parametrizado para os 3 serviços Node do FIAP X.
#
#   docker build -f docker/node-service.Dockerfile \
#     --build-arg APP=video-worker --build-arg WITH_FFMPEG=true \
#     --build-arg APP_VERSION=sha-$(git rev-parse --short=7 HEAD) \
#     --build-arg VCS_REF=$(git rev-parse HEAD) \
#     -t fiapx-video-worker .
#
# APP          video-api | video-worker | notification-service (obrigatório)
# WITH_FFMPEG  true só no video-worker (ffmpeg/ffprobe do Alpine); aceita só true|false
# APP_VERSION  versão de build (sha-<7> no CI); aparece em /health e nos logs
# VCS_REF      SHA completo do commit (label org.opencontainers.image.revision)
#
# Healthcheck: docker/healthcheck.sh deriva a URL do app (api: :PORT/api/health/live;
# worker e notification: :METRICS_PORT/health). HEALTH_URL no ambiente sobrescreve.
#
# Sem linha "# syntax": usa o frontend embutido no BuildKit (evita um pull do Docker Hub
# por build). A base é fixada por tag + digest (índice multi-arch), igual ao compose; o
# Dependabot (ecossistema docker) atualiza os dois juntos.
# =============================================================================
FROM node:26.10-alpine3.24@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS base
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app

# ---- deps: todas as dependências (inclui dev, para o build) -------------------
FROM base AS deps
COPY package.json package-lock.json ./
# sharing=shared: deps e prod-deps rodam em paralelo no mesmo cache (o cacache do npm é
# seguro para acesso concorrente).
RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --no-audit --no-fund

# ---- build: compila SÓ o app pedido (webpack gera um único dist/apps/$APP/main.js)
FROM deps AS build
ARG APP
RUN case "$APP" in \
      video-api|video-worker|notification-service) ;; \
      *) echo "ARG APP inválido: '$APP' (use video-api, video-worker ou notification-service)" >&2; exit 1 ;; \
    esac
COPY nest-cli.json tsconfig.json ./
COPY libs ./libs
COPY apps ./apps
RUN node_modules/.bin/nest build "$APP"

# ---- prod-deps: só dependências de produção ------------------------------------
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --omit=dev --no-audit --no-fund

# ---- runtime -----------------------------------------------------------------
FROM base AS runtime
ARG APP
ARG WITH_FFMPEG=false

# tini como PID 1: repassa SIGTERM ao Node (graceful shutdown) e recolhe zumbis do ffmpeg.
# Versões do apk vêm do Alpine fixado pelo digest da base (DL3018 ignorado no .hadolint.yaml).
RUN case "$WITH_FFMPEG" in \
      true|false) ;; \
      *) echo "ARG WITH_FFMPEG inválido: '$WITH_FFMPEG' (use true ou false)" >&2; exit 1 ;; \
    esac \
 && apk add --no-cache tini \
 && if [ "$WITH_FFMPEG" = "true" ]; then apk add --no-cache ffmpeg; fi \
 && mkdir -p /work \
 && chown 1000:1000 /work

# Dependências, bundle e healthcheck ficam com dono root (somente leitura para o usuário node).
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist/apps/${APP}/ ./dist/
COPY package.json ./
COPY --chmod=0755 docker/healthcheck.sh /usr/local/bin/healthcheck

# Metadados que mudam a cada commit ficam por último (não invalidam o cache das camadas acima).
ARG APP_VERSION=dev
ARG VCS_REF=unknown
ENV NODE_ENV=production \
    APP_NAME=${APP} \
    APP_VERSION=${APP_VERSION}

LABEL org.opencontainers.image.title="fiapx-${APP}" \
      org.opencontainers.image.description="FIAP X: ${APP} (NestJS)" \
      org.opencontainers.image.source="https://github.com/arthurfcs98/fiap-fase5-fiapx" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.vendor="FIAP SOAT - Arthur Cesarino"

# UID/GID numéricos (usuário "node" da imagem oficial): o Kubernetes só consegue validar
# runAsNonRoot com usuário numérico.
USER 1000:1000

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/usr/local/bin/healthcheck"]

# -e 143: o Nest encerra com graça no SIGTERM e depois reenvia o sinal ao próprio processo
# (saída 143). O tini converte 143 em 0, então parada normal (compose stop, rollout e
# scale-in no Kubernetes) não aparece como "Error".
ENTRYPOINT ["/sbin/tini", "-e", "143", "--"]
CMD ["node", "dist/main.js"]
