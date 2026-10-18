#!/bin/sh
set -eu
# One-command GPU Pod startup: prepare missing model weights, verify, then start router+secured API.
# MIGuy app is NOT installed here; this Pod serves an OpenAI-compatible inference API only.
KEYFILE="$(printenv MIGUY_GATEWAY_KEYS_FILE || echo /workspace/config/inference-clients.json)"
OWNER_KEY="$(printenv MIGUY_OWNER_API_KEY || true)"
if [ ! -r "$KEYFILE" ] && [ -z "$OWNER_KEY" ];then
 echo 'STOP: Set MIGUY_OWNER_API_KEY as a RunPod secret or provide hashed client config /workspace/config/inference-clients.json.' >&2
 exit 40
fi
if [ ! -c /dev/nvidia0 ] && [ ! -c /dev/nvidiactl ]; then
 echo 'STOP: NVIDIA GPU unavailable; check RunPod Docker image and GPU deployment' >&2
 exit 45
fi
command -v node >/dev/null && [ -x /app/llama-server ] || {
 echo 'STOP: Node.js gateway or pinned llama.cpp binary missing from image' >&2
 exit 46
}
CTX="$(printenv MIGUY_MODEL_CONTEXT || echo 167936)"
case "$CTX" in ''|*[!0-9]*) echo 'STOP: invalid context value' >&2;exit 47;;esac
if [ "$CTX" -lt 8192 ] || [ "$CTX" -gt 262144 ];then
 echo 'STOP: context must be 8192..262144; 40GB VRAM capability requires validation' >&2;exit 47
fi
if [ "$(printenv MIGUY_APPROVE_COMMUNITY_VARIANT || true)" != "1" ];then
 echo 'STOP: set MIGUY_APPROVE_COMMUNITY_VARIANT=1 to approve the explicitly selected unrestricted GGUF first.' >&2;exit 48
fi

echo 'MODEL_SETUP: downloading and verifying smallest complete model and vision projector FIRST.'
node /opt/miguy/ensure-models.cjs --initial
PRESETS="$(printenv MIGUY_ROUTER_PRESET_FILE || echo /workspace/config/active-models.ini)"

echo 'STARTING_PRIVATE_ROUTER: one model resident in VRAM, inference port on loopback only.'
/app/llama-server --models-preset "$PRESETS" --models-max 1 --models-autoload \
 --host 127.0.0.1 --port 8080 --no-webui >/tmp/miguy-router.log 2>&1 &
ROUTER_PID=$!

node /opt/miguy/gateway/server.cjs &
GATEWAY_PID=$!
# API is available with first model while the second downloads in the background.
# The downloader atomically updates the preset, asks llama.cpp to reload model
# metadata (without restarting), and only THEN advertises a newly ready model.
echo 'BACKGROUND_DOWNLOADS: preparing Qwen3.6 with its Vision projector while the first model serves requests.'
node /opt/miguy/ensure-models.cjs --remaining &
DOWNLOAD_PID=$!
TUNNEL_PID=''
TUNNEL_TOKEN_FILE=''
if [ -n "${TUNNEL_TOKEN:-}" ];then
 echo 'STARTING_CLOUDFLARE_TUNNEL: optional connector, will not stop the model gateway on failure.'
 # Explicit token-file avoids leaking bearer credentials in process arguments
 # or regular container logs. cloudflared 2026.10.0 supports --token-file.
 umask 077
 TUNNEL_TOKEN_FILE="/tmp/miguy-cloudflared-token-$$"
 printf '%s' "$TUNNEL_TOKEN" > "$TUNNEL_TOKEN_FILE"
 unset TUNNEL_TOKEN
 export TUNNEL_TOKEN_FILE
 (
  attempt=0
  while :;do
   attempt=$((attempt+1))
   echo "TUNNEL_ATTEMPT: $attempt"
   if /usr/local/bin/cloudflared tunnel --no-autoupdate run --token-file "$TUNNEL_TOKEN_FILE" >/tmp/miguy-cloudflared.log 2>&1;then rc=0;else rc=$?;fi
   echo "TUNNEL_RETRY: Cloudflare connector exited (code $rc). Inference gateway remains running; retry in 30 seconds."
   # Never print unredacted tunnel logs: CLI errors may include credentials.
   sleep 30
  done
 ) &
 TUNNEL_PID=$!
else
 echo 'NOTICE: TUNNEL_TOKEN absent. API remains up on configured port 8787, but do not send Bearer keys through unencrypted public HTTP.'
fi

cleanup(){
 kill "$DOWNLOAD_PID" "$GATEWAY_PID" "$ROUTER_PID" 2>/dev/null || true
 if [ -n "$TUNNEL_PID" ];then kill "$TUNNEL_PID" 2>/dev/null || true;fi
 if [ -n "$TUNNEL_TOKEN_FILE" ];then rm -f "$TUNNEL_TOKEN_FILE";fi
 wait "$GATEWAY_PID" "$ROUTER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
while kill -0 "$ROUTER_PID" 2>/dev/null && kill -0 "$GATEWAY_PID" 2>/dev/null; do
 # A temporary tunnel failure must never terminate inference or downloads.
 sleep 3
done
echo 'STOP: Required inference service exited. Inspect router and gateway logs.'
exit 1
