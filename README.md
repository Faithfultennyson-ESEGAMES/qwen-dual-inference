# MIGuy RunPod — two Vision models (v4)

Docker image: `faithfultennysonw/qwen-dual-inference:v4`.

**This is an additive new image, not an in-place update of the running v3 RunPod Pod. Never restart a Pod that is actively serving an agent solely to apply this change.**

## Only two models — smallest first

| Order | ID | GGUF quantization | Model + matched image projector |
| --- | --- | --- | --- |
| 1 | `qwen3.8-27b-uncensored` | Q4_K_M | 16,810,714,528 + 927,606,912 bytes = 17.738 GB |
| 2 | `qwen3.6-35b-a3b` | Q4_K_M | 20,419,565,568 + 614,194,304 bytes = 21.034 GB |

Total downloaded model files: **38,772,081,312 bytes (38.77 decimal GB / about 36.11 GiB)**, down ~56.71GB from v3. Both include their *own* validated matched `mmproj` for image input and retain native tool + bounded Thinking request support. Source versions and SHA-256 hashes are pinned in `inference/ensure-models.cjs`.

**Qwen3-Coder-Next 80B has been retired from v4:** no download, model preset, gateway alias or API discovery; older v3 image remains intact so existing running Pods and chat records are not abruptly destroyed.

## Progressive startup and dynamic discovery

`MIGUY_APPROVE_COMMUNITY_VARIANT=1` required to explicitly approve the selected Uncensored first model. Startup verifies first model + projector, then brings up private llama.cpp and HTTPS RunPod gateway on 8787. Second model downloads in background and appears in authenticated `GET /v1/models` after verification and router refresh. Only **one model** is GPU resident at a time; switching uses the private `/models/unload` / `/models/load` sequence. No unauthenticated model-control endpoints are available from the internet.

The `/v1/models` model objects include `context_length` set to the configured target; MIGuy uses this value for its per-model context and agent budgets, not a fixed advertised 167K. Available values of `MIGUY_MODEL_CONTEXT` are **8192 to 262144**; actual usable size depends on GPU VRAM, model architecture, projector, KV buffers and other memory overhead. **167,936 is only the previous A100 target, NOT a guarantee of fit on a 40GB GPU**.

## Deploy on RunPod (only when ready to migrate)

1. Verify GitHub Actions publish succeeded and new v4 Docker Hub tag exists: `faithfultennysonw/qwen-dual-inference:v4`.
2. Leave the current working v3 Pod alone. Make a new Pod only after reaching a safe checkpoint. One GPU, HTTP **8787**, no public 8080, Jupyter/SSH off, secure `MIGUY_OWNER_API_KEY`, and `MIGUY_APPROVE_COMMUNITY_VARIANT=1`.
3. For the new ~38.77GB total model cache, select a container disk with room for both weights/projectors, Docker layers, cache markers, work files and download temp (e.g. **70GB or more**, subject to actual disk availability). No persistent volume is required, but **stopping an ephemeral Pod deletes all downloaded weights**.
4. On a cheaper 40GB GPU, begin with a **32K or 64K context** and monitor GPU memory during realistic long agent tasks and screenshot Vision. Only raise context after verified successful tests. Reaching 22–28GB now is not proof that 167,936 tokens fit in 40GB VRAM.
5. MIGuy Settings → API connections → RunPod GPU Endpoint: update to the **new** Pod's HTTPS port-8787 proxy URL and same private key, Save and verify, Refresh models, enable the two models. Existing chats are retained; the retired coding model cannot be selected.
6. Test BOTH models independently: Thinking on/off, tool call+result, native PNG screenshot analysis with matching projector, A→B→A switching, long multi-step run budget, 32K→64K→128K memory sweep. Stop when memory pressure or OOM appears; do not promise 130K input+30K output until full-context acceptance.

## Cost and safety

Removing the coder weights reduces **startup downloads and disk footprint**. It does **not change the current A100's hourly rental charge**, since those charges depend on GPU selection. Only moving to a cheaper GPU plan reduces GPU hourly rates. Source changes and publishing do not alter or remotely delete files from the currently active Pod.

Production acceptance and real GPU benchmarks are still needed after migration.
