import time

from ap.config import settings
from ap.storage import client
from botocore.exceptions import ClientError, EndpointConnectionError

for attempt in range(20):
    try:
        s3 = client()
        try:
            s3.head_bucket(Bucket=settings.s3_bucket)
        except ClientError as exc:
            if exc.response["Error"]["Code"] not in ("404", "NoSuchBucket"):
                raise
            s3.create_bucket(Bucket=settings.s3_bucket)
        print("Private document bucket ready")
        break
    except EndpointConnectionError:
        if attempt == 19:
            raise
        time.sleep(1)
