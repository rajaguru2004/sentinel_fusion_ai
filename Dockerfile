# syntax=docker/dockerfile:1
# Multi-stage, CPU-only image for the Sentinel Fusion AI scoring API.
# Trained model bundles (models/*.joblib, ~5 MB) are baked in from the build
# context — they are gitignored, so the image is the artifact of record.

# ---------------------------------------------------------------- builder ----
FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build

# Only the metadata needed to resolve deps first (better layer caching).
COPY pyproject.toml README.md* readme.md* ./
COPY ml/ ./ml/
COPY service/ ./service/

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
# serve = API runtime; train = shap (needed for the default ?explain=true path).
RUN pip install ".[serve,train]"

# ---------------------------------------------------------------- runtime ----
FROM python:3.12-slim AS runtime

# libgomp1: OpenMP runtime required by xgboost / lightgbm wheels.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    SENTINEL_MODELS_DIR=/app/models
WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
COPY ml/ ./ml/
COPY service/ ./service/
COPY models/ ./models/

# Non-root.
RUN useradd -r -u 10001 sentinel && chown -R sentinel:sentinel /app
USER sentinel

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health').status==200 else 1)"

# --factory so each worker builds and warms its own scorer singleton.
CMD ["uvicorn", "service.app:create_app", "--factory", \
     "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
