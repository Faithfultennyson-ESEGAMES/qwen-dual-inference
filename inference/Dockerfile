# Build on developer CPU/Docker BEFORE starting a paid RunPod GPU.
FROM node:22-bullseye-slim AS node-runtime
FROM cloudflare/cloudflared:2026.10.0 AS tunnel-runtime
FROM ghcr.io/ggml-org/llama.cpp:server-cuda-b8212

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=tunnel-runtime /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --chmod=755 start-dual-model.sh /opt/miguy/start-dual-model.sh
COPY --chmod=755 gateway/server.cjs /opt/miguy/gateway/server.cjs
COPY --chmod=644 ensure-models.cjs /opt/miguy/ensure-models.cjs
COPY --chmod=755 gateway/issue-client-key.cjs /opt/miguy/gateway/issue-client-key.cjs
COPY models.ini /opt/miguy/models.ini
# No model weights or API keys baked into the image.
RUN node --version && /usr/local/bin/cloudflared --version && test -x /app/llama-server && node --check /opt/miguy/ensure-models.cjs && node --check /opt/miguy/gateway/server.cjs
EXPOSE 8787
ENTRYPOINT ["/bin/sh","/opt/miguy/start-dual-model.sh"]
