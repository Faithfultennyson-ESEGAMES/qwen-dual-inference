# Qwen inference — remote Docker build package

This GitHub repository builds **one NEW image**: `faithfultennysonw/qwen-dual-inference:v1`. It does not touch `gateway-api` or `coding-api`.

## First-time build (no GPU required)

1. On GitHub, create an **empty private repository** named `qwen-dual-inference` in your account. Use **no template README**; we'll upload these files.
2. Upload the **contents of this folder**, so that `.github/workflows/publish.yaml` and `inference/Dockerfile` are both at the repository root. The GitHub web uploader may omit dotfolders; use GitHub Desktop or `git` if necessary.
3. On Docker Hub, create a **new repository** `faithfultennysonw/qwen-dual-inference`, separate from existing images. Use public visibility if you want RunPod to pull it without a registry secret.
4. Docker Hub → Account Settings → Security → Personal access tokens → create a token with **Read, Write** permissions scoped to the new repo where available. **Do not share the token in chat**.
5. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - `DOCKERHUB_USERNAME` = `faithfultennysonw`
   - `DOCKERHUB_TOKEN` = token generated in Docker Hub
6. GitHub repository → **Actions → Build and publish GPU inference image → Run workflow**. The workflow runs the local gateway/downloader tests, builds the CUDA image on a GitHub runner, checks that llama-server supports `--models-preset` and `--models-max`, and **only pushes if those checks pass**.
7. Verify on Docker Hub that `faithfultennysonw/qwen-dual-inference:v1` exists before paying RunPod.

## IMPORTANT GPU and storage constraints

Your current RunPod confirmation shows **A100 SXM at $1.79/hour plus 30GB container disk at $0.004/hour**. For zero persistent storage, increase **container disk to 120GB**, set volume size 0 if allowed, and make sure RunPod's total disk can allocate this. If you download only Qwen3-Coder-Next Q5_K_M (~56.7GB), even that model **cannot fit in a 30GB container disk**. Both models together are ~73.5GB. At the screen's linear disk price, 120GB is ~$0.016/hour, GPU+disk ~$1.806/hour, so a strict $10 covers ~5.53 hours MAX including downloads/startup, not seven.

No stored model cache survives a stopped/terminated container-disk-only Pod. Each fresh Pod starts by downloading again. Model runs with configured 167,936 context tokens for 130K input + 30K output, but VRAM/performance are still **unverified** on A100. No guarantee until actual GPU acceptance.

Do not put `MIGUY_OWNER_API_KEY` or `TUNNEL_TOKEN` in this repo or Dockerfile. Enter as RunPod environment secrets before launching.

## Current verification
Source local downloader integrity/resume/cache test: passed.
Gateway authentication/model ACL test: passed.
Full CUDA build on Windows: blocked by extremely slow multi-GB layer transfer and limited disk; GitHub Actions build is the workaround. This package is NOT proof of a published or tested GPU image.
