import asyncio
import math
import time
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, SecretStr

EmbeddingModel = Literal["text-embedding-3-small", "text-embedding-3-large"]
MODELS = ("text-embedding-3-small", "text-embedding-3-large")
DIMENSIONS = 256


class EmbeddingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    model: EmbeddingModel
    text: str = Field(min_length=1, max_length=2200)


class EmbeddingResult(BaseModel):
    model: EmbeddingModel
    outcome: Literal["succeeded", "failed"]
    vector: list[float] | None
    latencyMs: int
    inputTokens: int | None


def read_vector(payload: dict, model: EmbeddingModel) -> list[float] | None:
    if payload.get("model") != model:
        return None
    data = payload.get("data")
    if not isinstance(data, list) or len(data) != 1:
        return None
    item = data[0]
    if not isinstance(item, dict) or item.get("index") != 0:
        return None
    vector = item.get("embedding")
    if not isinstance(vector, list) or len(vector) != DIMENSIONS:
        return None
    if any(type(value) not in (float, int) or not math.isfinite(value) for value in vector):
        return None
    norm = math.hypot(*vector)
    if norm == 0 or not math.isfinite(norm):
        return None
    return [value / norm for value in vector]


async def generate_embedding(
    client: httpx.AsyncClient, body: EmbeddingRequest, key: SecretStr,
) -> EmbeddingResult:
    started = time.monotonic()
    vector = None
    input_tokens = None
    try:
        async with asyncio.timeout(8):
            response = await client.post(
                "https://api.openai.com/v1/embeddings",
                headers={"Authorization": "Bearer " + key.get_secret_value()},
                json={"model": body.model, "input": body.text, "dimensions": DIMENSIONS, "encoding_format": "float"},
            )
            response.raise_for_status()
            payload = response.json()
            if isinstance(payload, dict):
                usage = payload.get("usage")
                count = usage.get("prompt_tokens") if isinstance(usage, dict) else None
                if type(count) is int and 0 <= count <= 2_147_483_647:
                    input_tokens = count
                vector = read_vector(payload, body.model)
    except (httpx.HTTPError, TimeoutError, ValueError, OverflowError):
        pass
    return EmbeddingResult(
        model=body.model, outcome="succeeded" if vector is not None else "failed",
        vector=vector, latencyMs=round((time.monotonic() - started) * 1000), inputTokens=input_tokens,
    )
