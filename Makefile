PY := .venv/bin/python
PYTEST := .venv/bin/pytest

.PHONY: test test-all gates bench bench-baseline experiments retrain serve batch fixture lint gen-key

test:            ## fast tier: unit + integration + service (<3 min, no big data)
	$(PYTEST)

test-all:        ## everything incl. slow + quality + perf gates on real artifacts
	$(PYTEST) -m ""

gates:           ## model quality gates + benchmark regression check (non-zero exit on breach)
	$(PYTEST) -m "quality or perf"
	$(PY) -m ml.benchmark --check

bench:           ## full benchmark run, appends history
	$(PY) -m ml.benchmark

bench-baseline:  ## promote current benchmark run to committed baseline
	$(PY) -m ml.benchmark --update-baseline

experiments:     ## bounded improvement experiments (~30 min CPU)
	$(PY) -m ml.experiments.fraud_search
	$(PY) -m ml.experiments.behaviour_champion
	$(PY) -m ml.experiments.calibration_check

retrain:         ## retrain all models (writes bundles + CONTRACT_HASH)
	$(PY) -m ml.run_pipeline

gen-key:         ## generate a strong 256-bit API key for SENTINEL_API_KEYS
	@openssl rand -hex 32

serve:           ## run scoring API on :8000
	.venv/bin/uvicorn service.app:app --host 0.0.0.0 --port 8000 --workers 2

batch:           ## example batch scoring run (IN=... OUT=...)
	$(PY) -m ml.score_batch --input $(IN) --output $(OUT)

fixture:         ## regenerate committed test fixture from full parquet
	$(PY) -m tests.make_fixture

lint:
	.venv/bin/ruff check ml service tests

test-model-unit:
	$(PYTEST) tests/unit tests/integration -q

test-model-perf:
	$(PYTEST) tests/perf -m perf -v

test-model-quality:
	$(PYTEST) tests/quality -m quality -v

test-model-stress:
	$(PYTEST) tests/unit/test_model_stress.py tests/perf/test_model_stress_load.py -v

test-model:
	$(PYTEST) tests/unit tests/integration tests/unit/test_model_stress.py -q
	$(PYTEST) tests/quality -m quality -q
	$(PYTEST) tests/perf -m perf -q

benchmark-run:
	$(PY) -m ml.benchmark

benchmark-update-baseline:
	$(PY) -m ml.benchmark --update-baseline

stress-report:
	$(PY) -m ml.run_stress_report

