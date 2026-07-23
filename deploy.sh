#!/usr/bin/env bash
# Build & publish the Sentinel Fusion AI scoring image to Docker Hub.
#
# Runs on a machine that HAS the source + training data:
#   1. retrains all models from the latest code       (models/ regenerated)
#   2. builds the Docker image (fresh models baked in)
#   3. pushes it to Docker Hub under rajaguru2004/
#
# The host that runs the service then only needs docker-compose.yml (+ .env):
#   sudo docker compose pull
#   sudo docker compose up -d
#
# Usage:
#   ./deploy.sh [TAG]        # TAG defaults to "latest"
#   SKIP_TRAIN=1 ./deploy.sh # reuse existing models/, skip retraining
set -euo pipefail

IMAGE="rajaguru2004/sentinel-fusion-ai"
TAG="${1:-latest}"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
PY="$([ -x .venv/bin/python ] && echo .venv/bin/python || echo python3)"

cd "$(dirname "$0")"

echo ">> [1/4] retraining models from latest code"
if [ "${SKIP_TRAIN:-0}" = "1" ]; then
  echo "   SKIP_TRAIN=1 — reusing existing models/"
else
  "$PY" -m ml.run_pipeline
fi
for f in fraud cyber behaviour quantum; do
  test -f "models/${f}_bundle.joblib" || { echo "!! missing models/${f}_bundle.joblib"; exit 1; }
done
test -f models/fusion_engine.joblib || { echo "!! missing models/fusion_engine.joblib"; exit 1; }

echo ">> [2/4] building image ${IMAGE}:${TAG} (+ ${GIT_SHA})"
docker build -t "${IMAGE}:${TAG}" -t "${IMAGE}:${GIT_SHA}" .

echo ">> [3/4] checking Docker Hub auth"
if ! docker system info 2>/dev/null | grep -q "Username:"; then
  echo "   not logged in — run: docker login -u rajaguru2004"
  docker login -u rajaguru2004
fi

echo ">> [4/4] pushing to Docker Hub"
docker push "${IMAGE}:${TAG}"
docker push "${IMAGE}:${GIT_SHA}"

echo ""
echo "done. published ${IMAGE}:${TAG} and ${IMAGE}:${GIT_SHA}"
echo "on the host:  export SENTINEL_API_KEYS=...  &&  sudo docker compose pull  &&  sudo docker compose up -d"
