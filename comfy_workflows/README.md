# Adding a workflow

Two machines are involved and they do different jobs:

- **`beam/lab/`** — a Pod with the real ComfyUI UI. Where you open a workflow,
  install its custom nodes, run it, and decide whether it is any good.
- **`beam/comfy/`** — a task_queue with no UI. What CreateGent calls, with every
  custom node pinned in its image.

Nothing installed in the lab reaches the worker on its own. That is the point of
the steps below.

## The two files, and why it is not really two files

A workflow lives here as a pair:

```
minimax_h3_r2v.json        <- what you downloaded from civitai. Never edited by hand.
minimax_h3_r2v.api.json    <- Export (API) of the same graph. What the worker runs.
```

You do not author either one. The first is the file you downloaded; the second
is one menu click off it. They exist because they carry different things:

| | `.json` (UI) | `.api.json` (export) |
|---|---|---|
| model download URLs | yes | no |
| which node came from which pack | yes | no |
| runnable by the worker | no | yes |

ComfyUI's `/prompt` endpoint only accepts the export, and the export throws away
the metadata that says where the weights come from. So the UI file is the recipe
and the export is the executable. Keep both, delete neither.

## Step by step

### 1. Start the lab

```bash
cd beam/lab && uv run --with beam-client python app.py
```

It prints a URL. Custom nodes installed there live on a volume, so this is a
one-time cost per node pack, not per session. Stop the pod from the dashboard
when you are done — it does not scale to zero.

### 2. Drop the downloaded workflow in here

```
comfy_workflows/minimax_h3_r2v.json
```

### 3. Ask what it needs

```bash
python scripts/ingest_workflow.py comfy_workflows/minimax_h3_r2v.json --sizes
```

Prints every weight (name, folder, download URL, size), whether the folders are
mapped in the worker, and which custom node packs are involved. Exits non-zero
if something needs a human.

### 4. Open it in the lab and install the missing nodes

Drag the JSON onto the canvas. **Manager → Install Missing Custom Nodes**,
restart when it asks. Or, from a terminal on the pod, in one pass:
`comfy node install-deps --workflow=<file>`.

This makes the graph runnable *there*. It has nothing to do with the worker —
those nodes get pinned separately in step 7.

### 5. Run it, then export

Now you can actually press Run and see whether the workflow is worth keeping.
Weights first — step 6 is usually done before this one, since a graph with no
weights fails validation.

When it produces something good: **Workflow → Export (API)**, saved beside the
original as `<name>.api.json`. Export the graph in the state that worked, with
the settings that produced the result.

### 6. Download the weights

```bash
python scripts/ingest_workflow.py comfy_workflows/minimax_h3_r2v.json --download
```

Runs a CPU container on Beam that pulls everything onto the models volume with
aria2c. Serverless, so the credits cover it. Storage is free under 1 TB and the
volume is shared with every other model, so nothing has to be deleted to make
room.

### 7. Pin the custom nodes in the worker

Skip if step 3 said every node is core.

```bash
python scripts/ingest_workflow.py comfy_workflows/minimax_h3_r2v.json --build-commands
```

Paste the lines into `beam/comfy/app.py` under `--- pinned custom nodes go below
this line ---`, then redeploy:

```bash
cd beam/comfy && uv run --with beam-client beam deploy app.py:handler
```

The worker's nodes are pinned at the version the workflow author used. They are
never installed at runtime, because a cold start that git-clones is a cold start
that can fail differently tomorrow than it did today.

### 8. Run it

Send `<name>.api.json` through the task_queue. Frozen values (the author's
prompt, their seed, their input filename) come along with the export, so the
first run is a reproduction of theirs. Making it callable from the app — prompt,
images, resolution as parameters — is a builder in `src/lib/comfy/`, which is
the one step no script can do for you.

## On Windows

Prefix Beam commands with `PYTHONIOENCODING=utf-8 PYTHONUTF8=1`. Without it the
SDK crashes printing its own progress bar against a cp1252 console, with a
traceback that looks like a deploy failure and is not.

## Two traps

**Bypass is not the same as a boolean.** A node you bypass (Ctrl+B) or mute
disappears from the export. A branch you switch off with a boolean widget stays,
and its models are still required — ComfyUI's missing-model check is a static
scan of every loader in the graph, so it blocks the run over a file the run
would never open. That is the `gemma4_e2b` situation from LTX.

**A workflow may not say where its weights come from.** `properties.models` is
written by the ComfyUI frontend when it knows the source — always for Comfy-Org
templates, often not for something assembled by hand and posted. Step 3 lists
those filenames and says it cannot resolve them. Finding them is manual, and no
tool can invent a URL.
