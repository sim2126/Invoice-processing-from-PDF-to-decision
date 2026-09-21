import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[3]
load_dotenv(ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    database_url: str = os.getenv(
        "DATABASE_URL", "postgresql+psycopg://ap:ap_local_only@localhost:5434/apdesk"
    )
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6381/0")
    origin: str = os.getenv("APP_ORIGIN", "http://localhost:3000").rstrip("/")
    secure: bool = os.getenv("COOKIE_SECURE", "false").lower() == "true"
    model: str = os.getenv("INVOICE_MODEL", "")
    api_key: str = os.getenv("OPENAI_API_KEY", "")
    s3_endpoint: str = os.getenv("S3_ENDPOINT", "http://localhost:9002")
    s3_key: str = os.getenv("S3_ACCESS_KEY", "apdesk_local")
    s3_secret: str = os.getenv("S3_SECRET_KEY", "apdesk_local_storage_only")
    s3_bucket: str = os.getenv("S3_BUCKET", "apdesk")
    s3_region: str = os.getenv("S3_REGION", "us-east-1")
    s3_addressing_style: str = os.getenv("S3_ADDRESSING_STYLE", "path")
    max_bytes: int = int(os.getenv("MAX_UPLOAD_MB", "10")) * 1024 * 1024
    max_pages: int = int(os.getenv("MAX_PAGES", "10"))
    max_pixels: int = 20_000_000
    session_hours: int = int(os.getenv("SESSION_HOURS", "24"))
    session_uploads: int = int(os.getenv("MAX_SESSION_UPLOADS", "40"))
    global_uploads: int = int(os.getenv("MAX_GLOBAL_UPLOADS_DAILY", "300"))
    global_calls: int = int(os.getenv("MAX_GLOBAL_MODEL_CALLS_DAILY", "100"))
    session_calls: int = int(os.getenv("MAX_SESSION_MODEL_CALLS_DAILY", "30"))


settings = Settings()
POLICY_VERSION = "AP-2026.1"
SCHEMA_VERSION = "invoice-1"
PROMPT_VERSION = "extract-1"
