import boto3
from botocore.config import Config

from .config import settings


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


def put(key: str, data: bytes, content_type="application/pdf"):
    client().put_object(Bucket=settings.s3_bucket, Key=key, Body=data, ContentType=content_type)


def get(key: str) -> bytes:
    return client().get_object(Bucket=settings.s3_bucket, Key=key)["Body"].read()
