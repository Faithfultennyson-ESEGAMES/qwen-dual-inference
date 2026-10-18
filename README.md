# MIGuy RunPod GPU inference — v3 progressive three-model release

This repo builds **faithfultennysonw/qwen-dual-inference:v3**, without overwriting the previous v1/v2 tags or the user's existing gateway/coding-api services.

## Startup order (progressive, one GPU model resident)

1. Qwen3.8-27B Uncensored Q4_K_M, **17.74GB** including its F16 image projector. Download and SHA-256 verify first, then start private llama.cpp router and authenticated gateway on port 8787. This model is immediately visible in `GET /v1/models` while the rest download.
2. Qwen3.6-35B-A3B Q4_K_M, **21.03GB**, including its matching Q8_0 image projector. Background download and verify, request router `/models?reload=1`, then publish to authenticated `GET /v1/models`.
3. Qwen3-Coder-Next 80B Q5_K_M, **56.71GB**, four GGUF shards. Background download and verify, request router reload, then publish. Coder-Next is **text+native tools only**; it does **not** support image input or controllable Thinking.

Total model+projector files ~95.48GB. These files plus image layers must fit in the selected 120GB **temporary container disk**, with some spare space. No network/persistent volume is used initially. **Stop/terminate the Pod erases its ephemeral model cache and requires re-download.** The stopped GPU currently must remain stopped until the new image is published and reviewed.

Model downloads use pinned Hugging Face revisions/sha256 checksums and resumable range transfers. The official/runtime files are not bundled into the Docker image.

The live API uses `https://<POD-ID>-8787.proxy.runpod.net` with Bearer authentication. The current owner key can be reused if it remains secure. MIGuy Settings → Models → API connections → RunPod GPU Endpoint → Save and verify → Browse models → select each → Save selected. **Refresh models** fetches models added while background downloads complete. Changes in selected `model` ID cause private router load/unload, under a shared inference slot; port 8080 and low-level model administration remain loopback-only and inaccessible publicly.

## GPU configuration

- **Image:** `faithfultennysonw/qwen-dual-inference:v3` (ONLY after Docker Hub CI succeeds).
- **GPU:** one RunPod A100 SXM 80GB, expected $1.79/hr plus temp disk around $0.017/hr per prior RunPod screenshot; check live quote. At $1.81/hr, $10 funds at most ~5.5h **including initial downloads**. This is an estimate, not a charge guarantee.
- **Container disk:** 120 GB; **volume size 0** if supported; no external network volume; HTTPS port 8787, **no Jupyter or public SSH**.
- **Environment:** `MIGUY_OWNER_API_KEY` strong secret `mg_` + 40+ random urlsafe chars; `MIGUY_APPROVE_COMMUNITY_VARIANT=1` required for the specifically selected first model. `MIGUY_MODEL_CONTEXT` defaults 167936, a configured **target** for 130K input + 30K output, not guaranteed to fit 80GB VRAM.
- `TUNNEL_TOKEN` optional for a Cloudflare named tunnel; otherwise use RunPod HTTPS proxy.

## Vision and tools

Both 27B Uncensored and 35B-A3B have model-specific **mmproj** in llama presets and accept safe inline PNG/JPEG/WebP base64 through the authenticated gateway. The gateway rejects remote image URLs and image requests sent to Coder-Next. MIGuy marks Vision/Thinking based on the *actual* model catalog, rather than pretending the image-blind model can see screenshots. Human-facing capabilities remain *GPU-unverified* until a real screenshot analysis returns correct details.

`tools` are forwarded unmodified (up to 256 valid function definitions or 2MB schema). MIGuy independently controls permissions for tool execution, including PMCA actions. Thinking ON uses bounded `reasoning_budget_tokens` with room for a final answer/tool result; system prompts and images count against total runtime context.

## Build procedure (no paid GPU)

GitHub repository: `Faithfultennyson-ESEGAMES/qwen-dual-inference`. GitHub repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` must already exist. **Never paste tokens into chat, logs or git.**

The `.github/workflows/publish.yaml` workflow runs on changed inference code in `main` or manually via Actions → Run workflow. It executes Node tests, builds pinned current llama.cpp CUDA, checks its CLI supports `--models-preset`, `--models-max`, `--models-autoload`, and `--mmproj`, then pushes the image to Docker Hub. If any check fails, **DO NOT RENT THE GPU**; first repair GitHub workflow or Docker image.

### Required live GPU acceptance after build

- Confirm latest A100 CUDA runtime boots; first model cached/verified and discoverable while background model downloads are still in progress.
- Prompt Qwen3.8 Uncensored to analyze a known browser PNG screenshot; verify correct UI elements; run a structured native tool call and Thinking ON with capped reasoning.
- Wait for Qwen3.6 + projector; Refresh models in MIGuy; test independent screenshot and tool call; request A→B→A and check model unload/load, no failures.
- Wait for Coder-Next; refresh; verify it refuses image input while coding/text tools work.
- Check **real VRAM**, 16K/32K/64K/128K/160K contexts before committing to 130K+30K; never silently downscale the advertised context.
- If model loading fails, share sanitized logs and DO NOT restart GPU automatically with ephemeral storage.

**Current status:** offline tests complete; the v3 Docker Hub build/publish and GPU acceptance must be separately verified.
