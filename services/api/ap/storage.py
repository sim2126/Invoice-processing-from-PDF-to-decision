import boto3
from botocore.config import Config

from .config import FIXTURES, settings

# Seeded history is served from the read-only fixtures built into the image,
# never copied into per-workspace object storage.
FIXTURE_PREFIX = "fixture/"


def client():
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_key,
        aws_secret_access_key=settings.s3_secret,
        region_name=settings.s3_region,
        config=Config(
            connect_timeout=5,
            read_timeout=20,
            retries={"max_attempts": 2},
            s3={"addressing_style": settings.s3_addressing_style},
        ),
    )


def fixture_path(key: str):
    root = FIXTURES.resolve()
    path = (root / key.removeprefix(FIXTURE_PREFIX)).resolve()
    if root not in path.parents:
        raise KeyError("Fixture key outside the fixtures directory")
    return path


def page_key(workspace_id: str, invoice_id: str, object_key: str, page: int) -> str:
    """Rendered page images live next to fixture PDFs, or under the invoice in storage."""
    if object_key.startswith(FIXTURE_PREFIX):
        return f"{object_key.removesuffix('.pdf')}.page-{page}.png"
    return f"{workspace_id}/{invoice_id}/page-{page}.png"


def put(key: str, data: bytes, content_type="application/pdf"):
    if key.startswith(FIXTURE_PREFIX):
        raise ValueError("Fixture documents are read-only.")
    client().put_object(Bucket=settings.s3_bucket, Key=key, Body=data, ContentType=content_type)


def get(key: str) -> bytes:
    if key.startswith(FIXTURE_PREFIX):
        return fixture_path(key).read_bytes()
    return client().get_object(Bucket=settings.s3_bucket, Key=key)["Body"].read()
