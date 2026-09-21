"""Checks account access without printing credentials; extraction smoke test is separate."""

import sys

sys.path.insert(0, "services/api")
from ap.config import settings
from openai import OpenAI

if not settings.api_key or not settings.model:
    raise SystemExit("Set OPENAI_API_KEY and INVOICE_MODEL in .env")
try:
    model = OpenAI(api_key=settings.api_key, timeout=20, max_retries=0).models.retrieve(
        settings.model
    )
    print("Account can access model:", model.id)
except Exception as exc:
    print("Model access check failed:", type(exc).__name__)
    raise SystemExit(1)
