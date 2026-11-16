import json
import math

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main

MODEL = "text-embedding-3-small"
TOKEN = "a" * 64
BODY = {"model": MODEL, "text": "Public gig title\n\nPublic gig description"}
HEADERS = {"Authorization": "Bearer " + TOKEN}


@pytest.mark.parametrize(("provider_model", "vector", "outcome"), [
    (MODEL, [3, 4] + [0] * 254, "succeeded"),
    (MODEL, [1] * 255, "failed"),
    (MODEL, [0] * 256, "failed"),
    (MODEL, [True] * 256, "failed"),
    ("incorrect-model", [1] * 256, "failed"),
])
def test_embedding_validates_provider_model_and_vector(monkeypatch, provider_model, vector, outcome):
    monkeypatch.setenv("AI_INTERNAL_TOKEN", TOKEN)
    monkeypatch.setenv("AI_OPENAI_API_KEY", "fixture-key")
    monkeypatch.setenv("AI_OPENAI_MODEL", "")
    monkeypatch.setenv("AI_EMBEDDING_MODEL", MODEL)
    calls = []

    def respond(request):
        calls.append(request)
        assert str(request.url) == "https://api.openai.com/v1/embeddings"
        assert request.headers["authorization"] == "Bearer fixture-key"
        assert json.loads(request.content) == {
            "model": MODEL, "input": BODY["text"], "dimensions": 256, "encoding_format": "float",
        }
        return httpx.Response(200, json={
            "model": provider_model, "data": [{"index": 0, "embedding": vector}],
            "usage": {"prompt_tokens": 12},
        })

    transport = httpx.MockTransport(respond)
    monkeypatch.setattr(main, "AsyncClient", lambda **kwargs: httpx.AsyncClient(transport=transport, **kwargs))
    with TestClient(main.app) as client:
        assert client.get("/health/ready").json()["capabilities"] == ["listing-embeddings"]
        assert client.post("/internal/embeddings", json=BODY).status_code == 401
        assert client.post("/internal/embeddings", headers=HEADERS, json={**BODY, "model": "text-embedding-3-large"}).status_code == 409
        assert client.post("/internal/embeddings", headers=HEADERS, json={**BODY, "privateField": "rejected"}).status_code == 422
        assert calls == []
        response = client.post("/internal/embeddings", headers=HEADERS, json=BODY)
        assert response.status_code == 200
        result = response.json()
        assert len(calls) == 1
        assert result["outcome"] == outcome
        assert result["model"] == MODEL
        assert result["inputTokens"] == 12
        if outcome == "succeeded":
            assert math.hypot(*result["vector"]) == pytest.approx(1)
            assert result["vector"][:2] == pytest.approx([0.6, 0.8])
        else:
            assert result["vector"] is None


def test_embedding_is_disabled_by_default(monkeypatch):
    monkeypatch.setenv("AI_EMBEDDING_MODEL", "")
    with TestClient(main.app) as client:
        assert client.post("/internal/embeddings", headers=HEADERS, json=BODY).status_code == 503
