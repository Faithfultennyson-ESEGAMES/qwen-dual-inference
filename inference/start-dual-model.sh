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
if [ "$CTX" -lt 160000 ];then
 echo 'STOP: context must support 130K input plus 30K output' >&2;exit 47
fi
if [ "$(printenv MIGUY_ENABLE_SECOND_MODEL || true)" = "1" ] &&
   [ "$(printenv MIGUY_APPROVE_COMMUNITY_VARIANT || true)" != "1" ];then
 echo 'STOP: approve and pin the second community model variant before download' >&2;exit 48
fi

echo 'MODEL_SETUP: verifying cache and downloading ONLY missing pinned model shards.'
node /opt/miguy/ensure-models.cjs

PRESETS=/opt/miguy/models.ini
if [ "$(printenv MIGUY_ENABLE_SECOND_MODEL || true)" != "1" ]; then
 # Do not advertise a community model unless its owner explicitly opts in.
 PRESETS=/tmp/miguy-one-model.ini
 sed '/^\[qwen3\.8-27b-uncensored\]/,$d' /opt/miguy/models.ini > "$PRESETS"
fi

echo 'STARTING_PRIVATE_ROUTER: one model resident in VRAM, inference port on loopback only.'
/app/llama-server --models-preset "$PRESETS" --models-max 1 \
 --host 127.0.0.1 --port 8080 --no-webui >/tmp/miguy-router.log 2>&1 &
ROUTER_PID=$!

node /opt/miguy/gateway/server.cjs &
GATEWAY_PID=$!
TUNNEL_PID=''
if [ -n "$(printenv TUNNEL_TOKEN || true)" ];then
 echo 'STARTING_CLOUDFLARE_TUNNEL: hostname is configured externally in Cloudflare.'
 /usr/local/bin/cloudflared tunnel --no-autoupdate run >/tmp/miguy-cloudflared.log 2>&1 &
 TUNNEL_PID=$!
else
 echo 'NOTICE: No Cloudflare Tunnel token provided; use RunPod HTTPS proxy only if port 8787 is configured, and keep the Bearer token private.'
fi

cleanup(){
 kill "$GATEWAY_PID" "$ROUTER_PID" 2>/dev/null || true
 if [ -n "$TUNNEL_PID" ];then kill "$TUNNEL_PID" 2>/dev/null || true;fi
 wait "$GATEWAY_PID" "$ROUTER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
while kill -0 "$ROUTER_PID" 2>/dev/null && kill -0 "$GATEWAY_PID" 2>/dev/null; do
 if [ -n "$TUNNEL_PID" ] && ! kill -0 "$TUNNEL_PID" 2>/dev/null;then
  echo 'STOP: Cloudflare Tunnel unexpectedly exited.' >&2
  break
 fi
 sleep 3
done
echo 'STOP: Required inference service exited. Inspect router and gateway logs.'
exit 1
