"""R2 object storage access via boto3 (S3-compatible)."""

import boto3
from botocore.config import Config

import config


_client = None


def client():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=config.R2_ENDPOINT,
            aws_access_key_id=config.R2_ACCESS_KEY_ID,
            aws_secret_access_key=config.R2_SECRET_ACCESS_KEY,
            region_name="auto",
            config=Config(signature_version="s3v4"),
        )
    return _client


def download_video(key: str, local_path: str):
    client().download_file(config.R2_BUCKET, key, local_path)


def upload_bytes(key: str, data: bytes, content_type: str):
    client().put_object(
        Bucket=config.R2_BUCKET, Key=key, Body=data, ContentType=content_type
    )


def get_object(key: str) -> bytes:
    resp = client().get_object(Bucket=config.R2_BUCKET, Key=key)
    return resp["Body"].read()
