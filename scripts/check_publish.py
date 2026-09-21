"""Check the exact Git index before publication; never print credential values."""

import re
import subprocess
from pathlib import PurePosixPath

ROOT_FILES = {
    ".gitignore",
    ".dockerignore",
    ".env.example",
    "README.md",
    "alembic.ini",
    "compose.yaml",
    "compose.dev.yaml",
    "pyproject.toml",
    "uv.lock",
}
SOURCE_ROOTS = {"apps", "services", "scripts", "tests"}
SOURCE_SUFFIXES = {
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    ".css",
    ".ps1",
    ".toml",
    ".yaml",
    ".yml",
    ".ini",
    ".sql",
}
CONFIG_NAMES = {
    "Dockerfile",
    ".dockerignore",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "components.json",
}
FORBIDDEN_PARTS = {
    "docs",
    "fixtures",
    "datasets",
    "data",
    "uploads",
    ".local",
    ".codex",
    ".agents",
    "node_modules",
    ".next",
    "__pycache__",
    "test-results",
    "playwright-report",
}
SECRETS = re.compile(
    rb"sk-(?:proj-)?[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
)


def git(*arguments):
    return subprocess.check_output(["git", *arguments])


def main():
    paths = [p.decode("utf-8") for p in git("ls-files", "-z").split(b"\0") if p]
    if not paths:
        raise SystemExit("Nothing is staged for publication.")
    rejected = []
    for name in paths:
        path = PurePosixPath(name)
        allowed = name in ROOT_FILES or (
            path.parts[0] in SOURCE_ROOTS
            and (path.suffix in SOURCE_SUFFIXES or path.name in CONFIG_NAMES)
        )
        if not allowed or any(part in FORBIDDEN_PARTS for part in path.parts):
            rejected.append((name, "outside code-only allowlist"))
            continue
        content = git("show", ":" + name)
        if b"\0" in content:
            rejected.append((name, "binary content"))
        if SECRETS.search(content):
            rejected.append((name, "credential-shaped content"))
    if rejected:
        for name, reason in rejected:
            print(f"REJECTED: {name} ({reason})")
        raise SystemExit(1)
    print(
        f"Publication check passed: {len(paths)} source/configuration files; no PDFs, datasets, reports, internal files or detected secrets."
    )


if __name__ == "__main__":
    main()
