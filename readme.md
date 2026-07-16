# sentinel_fusion_ai

ML model training project (fastai + PyTorch). Models trained and exported via Jupyter notebooks.

## Setup

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Kaggle credentials

Create `.env` in project root:

```
KAGGLE_USERNAME=your_username
KAGGLE_TOKEN=your_api_token
```

## Workflow

1. Open `train_model.ipynb` in Jupyter / VS Code
2. Set dataset slug in the Kaggle download cell
3. Run all cells: download → extract → train → evaluate → export `.pkl`

## Phase 1 — Dataset Collection & Preprocessing

```
data/raw/         raw downloads (gitignored): cyber, financial, behaviour, threat_intel
data/clean/       cleaned per-dataset parquet
data/unified/     part_*.parquet + unified_events.parquet + unified_events_engineered.parquet
notebooks/        01-13 preprocessing/unify/features/validation notebooks
notebooks/src/    percent-format sources (python notebooks/_make_nb.py regenerates .ipynb)
docs/             unified_schema.md, data_dictionary.md
reports/          per-dataset stats, EDA figures, validation_report.{json,md}
```

Run order: 01→10 (any order, independent), then 11_unify → 12_feature_engineering → 13_validation_report.

Re-download raw data: `bash` the Kaggle slugs in `docs/data_dictionary.md` (creds via `.env`).
