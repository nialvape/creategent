"""Preflight a ComfyUI workflow before it goes anywhere near a worker.

Answers, from the workflow file alone: which weights does this need and where do
they come from, which folders must be symlinked, which custom nodes must be in
the image, and what of all that is already handled.

    python scripts/ingest_workflow.py path/to/workflow.json
    python scripts/ingest_workflow.py path/to/workflow.json --sizes
    python scripts/ingest_workflow.py path/to/workflow.json --manifest

Feed it the **UI-format** JSON — the file ComfyUI saves, or the one civitai
hands you — not the API export. That is not a preference, it is where the
information lives: the API export is `class_type` + `inputs` and nothing else,
while the UI format carries, per node,

    properties.models   [{name, url, directory}]   <- the download URL and the
                                                     folder it belongs in
    properties.cnr_id   "comfy-core" | registry id <- whether it is a custom node
    properties.ver      version the author used

So the two files have different jobs and you want both: the UI JSON is the
build recipe, the API export is what the worker executes.

What this cannot do
-------------------
`properties.models` is written by the ComfyUI frontend when it knows where a
model came from — always true for Comfy-Org templates, often false for a
workflow someone assembled by hand and posted. When it is absent this prints the
filename and says so, which is still better than discovering it from a
`Value not in list` error twenty minutes into a cold start, but it is not a
download URL and no tool can invent one.

Likewise `cnr_id: null` is ambiguous: frontend-only nodes (notes, reroutes) have
it, and so does a custom node installed from git rather than the registry. Both
are listed, flagged as needing a human.
"""

import argparse
import json
import re
import sys
from collections import OrderedDict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# The serverless worker only sees model folders that are symlinked into
# ComfyUI's models/ at build time, and that list is a literal in its app.py.
# Parsing it here rather than duplicating it means this script cannot drift
# from what is actually deployed.
WORKER_APP = REPO_ROOT / "beam" / "comfy" / "app.py"

# Frontend-only node types: they carry no cnr_id and need nothing installed.
# Anything else with a null cnr_id is a real node from an unknown source.
FRONTEND_ONLY = {"MarkdownNote", "Note", "Reroute", "PrimitiveNode"}


def worker_model_dirs(path=WORKER_APP):
    """The MODEL_DIRS literal from the deployed worker, or None if unreadable."""
    try:
        src = path.read_text(encoding="utf-8")
    except OSError:
        return None
    m = re.search(r"^MODEL_DIRS\s*=\s*\[(.*?)\]", src, re.S | re.M)
    if not m:
        return None
    return [d for d in re.findall(r"[\"']([^\"']+)[\"']", m.group(1))]


def load_workflow(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict) and "nodes" in data:
        return data, "ui"
    # An API export is a flat {id: {class_type, inputs}} map. Still worth
    # accepting so the script can say what it cannot tell you from that file.
    if isinstance(data, dict) and all(
        isinstance(v, dict) and "class_type" in v for v in data.values()
    ):
        return data, "api"
    raise SystemExit("%s is neither a UI workflow nor an API export" % path)


def walk_nodes(workflow):
    """Every node, including those nested in subgraph definitions.

    Subgraphs matter: the LTX 2.5 template keeps half its loaders inside one,
    which is why its API export has ids like `398:393`. A scan that only reads
    the top level silently under-reports the models a graph needs.
    """
    yield from workflow.get("nodes", [])
    for sub in workflow.get("definitions", {}).get("subgraphs", []):
        for node in sub.get("nodes", []):
            yield node


def collect(workflow):
    models = OrderedDict()  # (name, directory) -> {url, nodes}
    packs = OrderedDict()  # cnr_id -> {ver, types}
    unknown = OrderedDict()  # node type -> count, for null cnr_id non-frontend
    unsourced = OrderedDict()  # filename referenced by a widget with no metadata

    # Declared names are gathered across the WHOLE workflow before anything is
    # judged unsourced, and that is not an optimization. A subgraph instance is
    # a node whose type is the subgraph's uuid, and it re-lists the widget
    # values of every node inside it while declaring no models of its own. Per
    # node, that makes each model look undeclared exactly once; globally, it
    # resolves against the declaration on the real loader inside the subgraph.
    declared = {
        entry.get("name")
        for node in walk_nodes(workflow)
        for entry in (node.get("properties") or {}).get("models") or []
    }

    for node in walk_nodes(workflow):
        ntype = node.get("type")
        props = node.get("properties") or {}

        for entry in props.get("models") or []:
            key = (entry.get("name"), entry.get("directory"))
            rec = models.setdefault(key, {"url": entry.get("url"), "nodes": []})
            rec["nodes"].append(ntype)

        cnr = props.get("cnr_id")
        if cnr and cnr != "comfy-core":
            pack = packs.setdefault(cnr, {"ver": props.get("ver"), "types": set()})
            pack["types"].add(ntype)
        elif not cnr and ntype not in FRONTEND_ONLY:
            unknown[ntype] = unknown.get(ntype, 0) + 1

        # A widget value that looks like a weight file that nothing in the
        # workflow declares. This is the "author picked it off their own disk"
        # case, and it is the one the automation cannot rescue.
        for value in node.get("widgets_values") or []:
            if not isinstance(value, str):
                continue
            if value.endswith((".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".bin")):
                if value not in declared:
                    unsourced.setdefault(value, ntype)

    return models, packs, unknown, unsourced


def registry_repo(cnr_id, timeout=20):
    """Repository URL for a Comfy registry node id, or None if the API cannot say."""
    import urllib.request

    try:
        with urllib.request.urlopen(
            "https://api.comfy.org/nodes/%s" % cnr_id, timeout=timeout
        ) as resp:
            return json.loads(resp.read().decode("utf-8")).get("repository")
    except Exception:
        return None


def head_size(url, timeout=20):
    """Content-Length via HEAD, following redirects. None when the host declines."""
    import urllib.request

    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            length = resp.headers.get("Content-Length")
            return int(length) if length else None
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("workflow", help="UI-format workflow JSON")
    ap.add_argument(
        "--sizes",
        action="store_true",
        help="HEAD each model URL for its real size (network, a second or two each)",
    )
    ap.add_argument(
        "--manifest",
        action="store_true",
        help="emit a models.py-shaped MODELS list instead of the report",
    )
    ap.add_argument(
        "--json",
        action="store_true",
        help="emit the manifest beam/models/download.py consumes",
    )
    ap.add_argument(
        "--build-commands",
        action="store_true",
        help="emit the add_commands lines that pin this workflow's custom nodes",
    )
    ap.add_argument(
        "--download",
        action="store_true",
        help="write the manifest and run beam/models/download.py on it (CPU container)",
    )
    args = ap.parse_args()

    workflow, fmt = load_workflow(args.workflow)
    if fmt == "api":
        raise SystemExit(
            "That is an API export. It has no model URLs and no node-source\n"
            "metadata, so nothing here can be derived from it. Point this at the\n"
            "UI-format file and keep the API export for the worker to execute."
        )

    models, packs, unknown, unsourced = collect(workflow)

    def build_manifest():
        """Manifest for the downloader, with the expected size of each file.

        The size is what lets the downloader tell "already there" from "half of
        it is already there". Without it the only available check is
        exists-and-nonempty, which passes a truncated file straight through and
        turns an interrupted download into a model-loading failure minutes into
        a cold start. One HEAD per file is cheap insurance; `null` when the host
        will not say, and the downloader then falls back to the weak check.
        """
        out = []
        for (name, directory), rec in models.items():
            out.append(
                {
                    "url": rec["url"],
                    "directory": directory,
                    "name": name,
                    "size": head_size(rec["url"]) if rec["url"] else None,
                }
            )
        return out

    if args.json:
        print(json.dumps(build_manifest(), indent=2))
        return 0

    if args.download:
        manifest = build_manifest()
        no_url = [m["name"] for m in manifest if not m["url"]]
        if no_url:
            print("Not downloadable, no URL in the workflow:")
            for name in no_url:
                print("  %s" % name)
            print("Find these by hand. Continuing with the rest.\n")
            manifest = [m for m in manifest if m["url"]]
        if not manifest:
            print("Nothing to download.")
            return 1

        # The manifest is written into beam/models because Beam syncs the
        # working directory of the app it deploys, and nothing outside it. Same
        # constraint that makes beam/comfy/app.py copy comfy_worker in.
        target = REPO_ROOT / "beam" / "models"
        (target / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print("Downloading %d file(s) on a CPU container." % len(manifest))
        import subprocess

        return subprocess.call(
            ["uv", "run", "--with", "beam-client", "python", "download.py", "manifest.json"],
            cwd=str(target),
        )

    if args.build_commands:
        if not packs:
            print("# Every node in this workflow is core. Nothing to pin.")
            return 0
        print("# Paste into add_commands in beam/comfy/app.py, then redeploy.")
        print("# Requires `pip install --no-cache-dir comfy-cli` in the same image.")
        print("#")
        print("# registry-install pins the exact version the workflow author used.")
        print("# The git clone under each line is the fallback for a node that is")
        print("# not in the registry, and it pins nothing - if you use it, replace")
        print("# the clone with a commit you have actually tested.")
        for cnr, pack in packs.items():
            ver = pack["ver"]
            print("\n# %s" % ", ".join(sorted(pack["types"])))
            print(
                '            "comfy --skip-prompt node registry-install %s%s",'
                % (cnr, "@%s" % ver if ver else "")
            )
            repo = registry_repo(cnr)
            if repo:
                print('            # or: "git clone --depth=1 %s"' % repo)
        return 0

    if args.manifest:
        print("# Generated by scripts/ingest_workflow.py from %s" % Path(args.workflow).name)
        print("# Sizes are in GB; verify them before trusting a VRAM budget.")
        print("MODELS = [")
        for (name, directory), rec in models.items():
            gb = ""
            if args.sizes and rec["url"]:
                size = head_size(rec["url"])
                if size:
                    gb = ", %.2f" % (size / 1e9)
            print('    ("%s", "%s", "%s"%s),' % (rec["url"] or "", directory, name, gb))
        print("]")
        return 0

    total = 0
    print("Models (%d)" % len(models))
    for (name, directory), rec in models.items():
        size_note = ""
        if args.sizes and rec["url"]:
            size = head_size(rec["url"])
            if size:
                total += size
                size_note = "  %.2f GB" % (size / 1e9)
        print("  %-17s %s%s" % (directory or "?", name, size_note))
        if not rec["url"]:
            print("                    (no URL in the workflow; you have to find this one)")
    if args.sizes and total:
        print("  %s" % ("-" * 40))
        print("  total on disk: %.2f GB" % (total / 1e9))

    dirs_needed = sorted({d for _, d in models if d})
    have = worker_model_dirs()
    print("\nModel folders: %s" % (", ".join(dirs_needed) or "none"))
    if have is None:
        print("  could not read MODEL_DIRS from %s" % WORKER_APP)
    else:
        missing = [d for d in dirs_needed if d not in have]
        if missing:
            print("  MISSING from the worker's MODEL_DIRS: %s" % ", ".join(missing))
            print("  Add them to beam/comfy/app.py and redeploy, or the loaders")
            print("  will not see the files even once they are on the volume.")
        else:
            print("  all present in the worker's MODEL_DIRS")

    print("\nCustom node packs: %s" % (len(packs) or "none - every node is core"))
    for cnr, pack in packs.items():
        print("  %s @ %s" % (cnr, pack["ver"] or "unpinned"))
        print("    used by: %s" % ", ".join(sorted(pack["types"])))
    if packs:
        print("\n  These have to be pinned in the worker's image. Installing them")
        print("  in the lab pod only makes the workflow runnable there -- its")
        print("  custom_nodes is a volume on a different machine. Build lines:")
        print("    python scripts/ingest_workflow.py %s --build-commands" % args.workflow)

    if unknown:
        print("\nNodes with no registry id (%d), source unknown, check by hand:" % len(unknown))
        for ntype, count in unknown.items():
            print("  %s (x%d)" % (ntype, count))

    if unsourced:
        print("\nWeight files named by a widget but not declared (%d):" % len(unsourced))
        for filename, ntype in unsourced.items():
            print("  %-55s %s" % (filename, ntype))
        print("  The workflow does not say where these come from.")

    blocking = bool(unknown or unsourced) or (have is not None and any(
        d not in have for d in dirs_needed
    ))
    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main())
