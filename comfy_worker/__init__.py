"""Shared, provider-agnostic pieces of a ComfyUI serverless worker.

Everything about *what a job means* — the input shape, which outputs count, how
they are serialized — lives in `contract`, which is stdlib-only and knows
nothing about RunPod or Beam. Both entrypoints import it, so the two backends
cannot drift apart on the thing the app depends on.

`client` is an optional extra: a small HTTP client for a local ComfyUI, used by
the Beam worker. It needs `requests`, so it is NOT imported here — importing
this package must stay free of third-party dependencies.
"""

from .contract import (
    DEFAULT_MIME,
    build_result,
    collect_outputs,
    legacy_images,
    mime_for,
    normalize_input,
)

__all__ = [
    "DEFAULT_MIME",
    "build_result",
    "collect_outputs",
    "legacy_images",
    "mime_for",
    "normalize_input",
]
