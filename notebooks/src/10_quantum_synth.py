# %% [markdown]
# # Quantum Risk Indicators — Synthetic Cryptographic Telemetry
#
# **No public labeled "quantum risk" dataset exists.** This notebook synthesizes
# TLS-handshake / certificate-inventory events with distributions grounded in
# published measurements:
#
# | Parameter | Grounding source |
# |---|---|
# | TLS version share (1.0: ~1%, 1.1: ~0.5%, 1.2: ~28%, 1.3: ~70%) | Qualys SSL Pulse + Cloudflare Radar 2024-2025 public stats |
# | Key exchange (X25519 ~55%, ECDHE-P256 ~30%, RSA-KEX ~3%, DHE ~2%, X25519+ML-KEM hybrid ~10%) | Cloudflare Radar PQC adoption telemetry |
# | Cert key type (RSA-2048 ~55%, RSA-4096 ~8%, RSA-1024 ~1%, ECDSA-P256 ~35%) | Censys / crt.sh aggregate scans |
# | Cipher suites, cert lifetimes | CA/B Forum baseline + SSL Pulse |
#
# **HNDL (Harvest-Now-Decrypt-Later) risk label heuristic** (interpretable, documented):
# risk = 1 when non-PQC key exchange AND (long-term-confidentiality data class)
# AND (large encrypted transfer OR legacy protocol OR weak/legacy key).
# This mirrors Mosca-theorem style exposure reasoning: data that must stay secret
# beyond ~2033 and is protected only by quantum-breakable KEX is harvestable today.

# %%
import sys
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
from prep_utils import to_unified, dataset_report, numeric_summary, save_clean, save_unified_part

rng = np.random.default_rng(42)
N = 250_000

# %% [markdown]
# ## Generate base TLS-handshake population

# %%
tls_versions = rng.choice(["tls1.0", "tls1.1", "tls1.2", "tls1.3"], N, p=[0.012, 0.006, 0.282, 0.70])
kex_by_tls = {
    "tls1.0": (["rsa_kex", "dhe", "ecdhe_p256"], [0.55, 0.25, 0.20]),
    "tls1.1": (["rsa_kex", "dhe", "ecdhe_p256"], [0.50, 0.25, 0.25]),
    "tls1.2": (["ecdhe_p256", "ecdhe_x25519", "rsa_kex", "dhe"], [0.45, 0.40, 0.10, 0.05]),
    "tls1.3": (["x25519", "ecdhe_p256", "x25519_mlkem768"], [0.62, 0.23, 0.15]),
}
kex = np.array([rng.choice(kex_by_tls[v][0], p=kex_by_tls[v][1]) for v in tls_versions])
cert_key = rng.choice(["rsa_1024", "rsa_2048", "rsa_4096", "ecdsa_p256", "ecdsa_p384"],
                      N, p=[0.012, 0.545, 0.083, 0.30, 0.06])
data_class = rng.choice(["public", "internal", "pii", "financial", "state_secret"],
                        N, p=[0.35, 0.35, 0.18, 0.10, 0.02])
# long-tail transfer sizes: most sessions small, few bulk exfil-scale
bytes_out = np.exp(rng.normal(9.5, 2.6, N))  # median ~13KB, tail to GBs
cert_age_days = rng.integers(1, 730, N)
cert_validity_days = rng.choice([90, 180, 365, 398, 730, 1095], N, p=[0.42, 0.08, 0.25, 0.15, 0.07, 0.03])
dst_country = rng.choice(["US", "DE", "IN", "SG", "CN", "RU", "NL", "GB", "BR", "JP"],
                         N, p=[0.30, 0.10, 0.12, 0.06, 0.08, 0.04, 0.07, 0.09, 0.06, 0.08])
device_id = np.char.add("srv-", rng.integers(1, 4000, N).astype(str))
event_time = (pd.Timestamp("2025-01-01", tz="UTC")
              + pd.to_timedelta(rng.uniform(0, 365 * 86400, N), unit="s"))

df = pd.DataFrame({
    "event_time": event_time, "device_id": device_id, "tls_version": tls_versions,
    "key_exchange": kex, "cert_key_type": cert_key, "data_class": data_class,
    "bytes_out": bytes_out.round(0), "cert_age_days": cert_age_days,
    "cert_validity_days": cert_validity_days, "dst_country": dst_country,
}).sort_values("event_time").reset_index(drop=True)
df.head(3)

# %% [markdown]
# ## HNDL risk label (interpretable rule, becomes training target)

# %%
pqc_safe = df["key_exchange"].eq("x25519_mlkem768")
legacy_tls = df["tls_version"].isin(["tls1.0", "tls1.1"])
weak_key = df["cert_key_type"].eq("rsa_1024")
long_secret = df["data_class"].isin(["pii", "financial", "state_secret"])
bulk_transfer = df["bytes_out"] > np.quantile(df["bytes_out"], 0.95)

df["quantum_exposed"] = (~pqc_safe).astype("int8")  # feature: KEX breakable by CRQC
df["label_hndl"] = ((~pqc_safe) & long_secret & (bulk_transfer | legacy_tls | weak_key)).astype("int8")
sev = np.select(
    [df["label_hndl"] == 1, legacy_tls | weak_key, ~pqc_safe],
    [4, 3, 1], 0).astype("int8")
df["severity"] = sev
print("HNDL-risk rate:", round(df["label_hndl"].mean(), 4))
df.groupby("data_class", observed=True)["label_hndl"].mean()

# %% [markdown]
# ## EDA + stats

# %%
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
fig, axes = plt.subplots(1, 3, figsize=(15, 4))
df["tls_version"].value_counts().plot.bar(ax=axes[0], title="TLS versions")
df["key_exchange"].value_counts().plot.barh(ax=axes[1], title="key exchange")
df.groupby("cert_key_type", observed=True)["label_hndl"].mean().plot.bar(ax=axes[2], title="HNDL rate by cert key")
plt.tight_layout(); plt.savefig("../reports/quantum_eda.png", dpi=110); plt.show()

# %%
numeric_summary(df, "quantum_synth")

# %% [markdown]
# ## Save clean + unified

# %%
save_clean(df, "quantum_synth")
dataset_report(df, "quantum_synth", label_col="label_hndl",
               notes="Fully synthetic; distributions grounded in SSL Pulse / Cloudflare Radar / Censys public stats. Rule-based HNDL label — interpretable by construction.")

# %%
u = pd.DataFrame({
    "event_time": df["event_time"],
    "event_subtype": df["tls_version"],
    "device_id": df["device_id"],
    "country": df["dst_country"],
    "bytes_out": df["bytes_out"],
    "severity": df["severity"],
    "label": df["label_hndl"].astype("Int8"),
    "time_is_synthetic": True,
})
attr = ["key_exchange", "cert_key_type", "data_class", "cert_age_days",
        "cert_validity_days", "quantum_exposed"]
u[attr] = df[attr]
u = to_unified(u, source_dataset="quantum_synth", event_domain="quantum",
               event_type="tls_handshake", label_type="quantum_risk", attributes_cols=attr)
save_unified_part(u, "quantum_synth")
u.head(3)
