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
