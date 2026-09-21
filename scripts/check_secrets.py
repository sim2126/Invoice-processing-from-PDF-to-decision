"""Scans deliverable source and browser bundles without ever printing secret values."""

import os
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
skip = {
    ".venv",
    "node_modules",
    ".git",
    ".local",
    "test-results",
    "playwright-report",
    "__pycache__",
}
hits = []
paths = []
for folder, directories, filenames in os.walk(root):
    directories[:] = [name for name in directories if name not in skip]
    paths.extend(Path(folder) / name for name in filenames)
for path in paths:
    if path.name == ".env" or path.suffix not in {
        ".py",
        ".ts",
        ".tsx",
        ".js",
        ".json",
        ".md",
        ".mjs",
        ".cjs",
        ".css",
    }:
        continue
    if re.search(rb"sk-proj-[A-Za-z0-9_-]{30,}", path.read_bytes()):
        hits.append(str(path.relative_to(root)))
if hits:
    print("Credential-shaped values found in:", ", ".join(hits))
    raise SystemExit(1)
print(
    "No project API key found in deliverable source or generated browser bundles; .env intentionally excluded."
)
