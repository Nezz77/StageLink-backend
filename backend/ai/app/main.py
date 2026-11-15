from contextlib import asynccontextmanager
from hmac import compare_digest
from re import fullmatch
import json
import logging
import time
import uuid
from fastapi import FastAPI, HTTPException, Request
from httpx import AsyncClient
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.preview import GEMINI_MODEL_ID, MODEL_ID, PreviewRequest, PreviewResult, Provider, ProviderName, generate_preview


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AI_", extra="ignore")
    service_name: str = Field(default="stagelink-ai", min_length=1, max_length=64)
    internal_token: SecretStr = SecretStr("")
    openai_api_key: SecretStr = SecretStr("")
    openai_model: str = ""
    gemini_api_key: SecretStr = SecretStr("")
    gemini_model: str = ""
    preview_primary_provider: ProviderName = "openai"
    preview_fallback: bool = False

    def provider(self, name: ProviderName) -> Provider | None:
        key, model, pattern = (self.openai_api_key, self.openai_model, MODEL_ID) if name == "openai" else (
            self.gemini_api_key, self.gemini_model, GEMINI_MODEL_ID,
        )
        if key.get_secret_value().strip() and fullmatch(pattern, model):
            return Provider(name, model, key)
        return None

    def primary_provider(self) -> Provider | None:
        if fullmatch(r"[a-f0-9]{64}", self.internal_token.get_secret_value()):
            return self.provider(self.preview_primary_provider)
        return None

    def fallback_provider(self) -> Provider | None:
        if self.preview_fallback:
            return self.provider("gemini" if self.preview_primary_provider == "openai" else "openai")
        return None

    def capabilities(self) -> list[str]:
        return ["prompt-preview"] if self.primary_provider() else ["health-only"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.settings = Settings()
    if "prompt-preview" not in app.state.settings.capabilities():
        yield
        return
    async with AsyncClient(follow_redirects=False, timeout=8) as client:
        app.state.model_client = client
        yield


logger = logging.getLogger("stagelink.ai")
logger.setLevel(logging.INFO)
logger.propagate = False
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)

app = FastAPI(title="StageLink AI service", version="0.1.0", lifespan=lifespan)


class Health(BaseModel):
    status: str
    service: str
    version: str
    capabilities: list[str]


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = str(uuid.uuid4())
    started = time.monotonic()
    try:
        response = await call_next(request)
    except Exception:
        response = JSONResponse(status_code=500, content={
            "code": "INTERNAL_ERROR", "message": "An unexpected error occurred", "requestId": request_id,
        })
    response.headers["X-Request-ID"] = request_id
    response.headers["Cache-Control"] = "no-store"
    # Do not log URLs/query strings, request bodies, keys or raw exception messages.
    logger.info(json.dumps({
        "event": "http.request",
        "requestId": request_id, "status": response.status_code,
        "durationMs": round((time.monotonic() - started) * 1000),
    }))
    return response


@app.get("/health/ready", response_model=Health)
async def health(request: Request):
    return Health(status="ready", service=request.app.state.settings.service_name,
                  version="0.1.0", capabilities=request.app.state.settings.capabilities())

@app.get("/health/live", response_model=Health)
async def live(request: Request):
    return Health(status="alive", service=request.app.state.settings.service_name,
                  version="0.1.0", capabilities=request.app.state.settings.capabilities())


@app.post("/internal/prompt-preview", response_model=PreviewResult)
async def prompt_preview(request: Request, body: PreviewRequest):
    settings = request.app.state.settings
    primary = settings.primary_provider()
    if primary is None:
        raise HTTPException(status_code=503, detail="Model preview unavailable")
    credential = ("Bearer " + settings.internal_token.get_secret_value()).encode()
    if not compare_digest(request.headers.get("authorization", "").encode(), credential):
        raise HTTPException(status_code=401, detail="Internal authorization required")
    return await generate_preview(
        request.app.state.model_client, body, primary, settings.fallback_provider(),
    )
