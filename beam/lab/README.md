# The ComfyUI lab

A Beam Pod running the real ComfyUI UI, with the Manager and with custom nodes
that survive a restart. This is where a workflow off civitai gets opened, run,
and judged before anything about it is committed to.

It is **not** what CreateGent calls. That is `beam/comfy/`, a task_queue whose
custom nodes are pinned in its image. Nothing installed here reaches it by
itself, and the separation is deliberate:

| | this lab | `beam/comfy` (the worker) |
|---|---|---|
| primitive | Pod (has a URL and a UI) | task_queue (takes jobs) |
| custom nodes | installed from the UI, whatever Manager resolves | git-pinned in the image |
| model folders | all 26 mapped | all 26 mapped |
| scales to zero | no — stop it yourself | yes |

## What it costs

Verified 2026-08-19 against the account's own usage log: **$0.00 charged, $0.04
credited, lifetime.** Every line item is a `function`; Pod time does not appear
in the usage list at all. Auto top-up is disabled and no credits have ever been
purchased, so the failure mode of exhausting the balance is a workload that will
not start, not a bill.

An earlier note in this repo hedged "do not plan around Pods being free", and
that hedge later got restated as if a Pod had charged the card. It had not. What
is separately true is that both grants carry a **Serverless only** eligibility
badge, which is why production runs on the task_queue.

## Run it

```bash
cd beam/lab && uv run --with beam-client python app.py
```

On Windows prefix with `PYTHONIOENCODING=utf-8 PYTHONUTF8=1`, or the Beam SDK
dies printing its own progress bar against a cp1252 console.

The pod does not scale to zero — stop it from the dashboard when you are done
for the day.

## What persists, and what does not

Two volumes, and the difference between them is the whole design:

- `comfy-nodes` → `/nodes`. Custom node clones land in `/nodes/custom_nodes`,
  and their pip dependencies in `/nodes/site`, because `PIP_TARGET` points there.
  Both survive restarting the pod.
- `ltx25-models` → `/models`. The weights, shared with `beam/comfy` and with the
  ltx25/h3r2v downloaders. Free under 1 TB.

`/nodes/site` is put on `sys.path` by a `.pth` file, **not** by `PYTHONPATH`, and
that is load-bearing. A `.pth` path is appended; `PYTHONPATH` is prepended. `pip
--target` cannot see what the container already has, so a node that lists `torch`
in its requirements will cheerfully download a second torch onto the volume —
appended, it is shadowed by the real cu128 build and never imported. Prepended,
it would take over and break the GPU. If a node install seems to pull gigabytes
for no reason, that is what happened: wasted space, not a broken environment.

Everything else — the container's site-packages, `/comfy` itself, the output
directory — is ephemeral. Finished files are copied to `comfy-lab-outputs` by a
loop in the startup script; the output directory itself is deliberately NOT on a
volume, because finalizing an MP4 there loses the moov atom.

## Loading a workflow off civitai

1. Drag the JSON onto the canvas.
2. **Manager → Install Missing Custom Nodes**, restart when it asks. For a
   workflow with a long tail of dependencies, from a terminal on the pod:
   `comfy node install-deps --workflow=<file>` — comfy-cli is in the image and
   does the whole list in one pass.
3. **Do not use the in-UI download button for weights.** It pulls them onto the
   GPU pod for a transfer a CPU container does for cents. Save the workflow and,
   locally:

```bash
python scripts/ingest_workflow.py <workflow.json> --sizes
python scripts/ingest_workflow.py <workflow.json> --download
```

4. Refresh node definitions (**R**) after a download. ComfyUI's missing-model
   check reads a cached folder listing, and a fresh file is invisible until then
   — the run fails validation with `Value not in list`.

## Promoting a workflow to the worker

```bash
python scripts/ingest_workflow.py <workflow.json> --build-commands
```

Emits the `add_commands` lines that pin each custom node at the version the
workflow author used, ready to paste into `beam/comfy/app.py` below the
`--- pinned custom nodes ---` marker. Then **Workflow → Export (API)** into
`comfy_workflows/`, redeploy the worker, and write the builder in
`src/lib/comfy/` that parameterizes it.

See `comfy_workflows/README.md` for the whole flow and for the two traps (bypass
is not the same as a boolean; not every workflow declares where its weights come
from).
