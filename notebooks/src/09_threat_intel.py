# %% [markdown]
# # Threat Intelligence — IOC Feeds, CVE, MITRE ATT&CK
#
# Five sources, one notebook (all small, same domain):
#
# | Dataset | Source | License | Content |
# |---|---|---|---|
# | URLhaus | abuse.ch dump (live) | CC0 | malicious URLs + threat type + timestamps |
# | Malicious URLs | Kaggle `sid321axn/malicious-urls-dataset` | public (aggregated academic) | 651k URLs labeled benign/defacement/phishing/malware |
# | Feodo Tracker | abuse.ch (live) | CC0 | botnet C2 IPs (Emotet/Dridex/QakBot...) |
# | CISA KEV | cisa.gov (live) | public domain | Known Exploited Vulnerabilities catalog |
# | MITRE ATT&CK | github.com/mitre/cti (STIX 2.1) | MITRE license (free w/ attribution) | enterprise techniques |
#
# All quality: authoritative production feeds — not toy. IOC rows: `label=1`.
# Context rows (KEV, ATT&CK): `label=-1` (enrichment, not training targets).

# %%
import sys, json
sys.path.insert(0, "..")
import numpy as np
import pandas as pd
from prep_utils import RAW, to_unified, dataset_report, save_clean, save_unified_part

D = RAW / "threat_intel"

# %% [markdown]
# ## 1. URLhaus — malicious URL feed (real timestamps)

# %%
import glob
uh_csv = glob.glob(str(D / "csv.txt")) or glob.glob(str(D / "*.txt")) or glob.glob(str(D / "csv" / "*"))
uh = pd.read_csv(uh_csv[0], comment="#", header=None,
                 names=["id", "dateadded", "url", "url_status", "last_online",
                        "threat", "tags", "urlhaus_link", "reporter"])
uh["dateadded"] = pd.to_datetime(uh["dateadded"], utc=True, errors="coerce")
uh = uh.dropna(subset=["dateadded", "url"]).drop_duplicates(subset=["url"]).reset_index(drop=True)
print(uh.shape); uh["threat"].value_counts()

# %%
uh_u = pd.DataFrame({
    "event_time": uh["dateadded"],
    "event_subtype": uh["threat"].astype(str),
    "severity": 3, "label": 1, "time_is_synthetic": False,
})
attr = ["url", "url_status", "tags", "reporter"]
uh_u[attr] = uh[attr]
uh_u["severity"] = uh_u["severity"].astype("int8"); uh_u["label"] = uh_u["label"].astype("int8")
uh_u = to_unified(uh_u, source_dataset="urlhaus", event_domain="threat_intel",
                  event_type="ioc_url", label_type="ioc", attributes_cols=attr)
save_clean(uh, "urlhaus")
save_unified_part(uh_u, "urlhaus")
dataset_report(uh, "urlhaus", label_col="threat", notes="Live abuse.ch dump; all rows malicious IOCs.")

# %% [markdown]
# ## 2. Kaggle Malicious URLs — benign + malicious mix (no timestamps → synthetic, flagged)

# %%
mu = pd.read_csv(glob.glob(str(D / "malicious_urls" / "*.csv"))[0])
mu.columns = [c.strip().lower() for c in mu.columns]
mu = mu.drop_duplicates(subset=["url"]).reset_index(drop=True)
print(mu.shape); print(mu["type"].value_counts())
mu["label_bin"] = (mu["type"] != "benign").astype("int8")

# %%
rng = np.random.default_rng(42)
anchor = pd.Timestamp("2021-01-01", tz="UTC")
mu["event_time"] = anchor + pd.to_timedelta(rng.uniform(0, 180 * 86400, len(mu)), unit="s")
sev = mu["type"].map({"benign": 0, "defacement": 2, "phishing": 3, "malware": 4}).fillna(2).astype("int8")
mu_u = pd.DataFrame({
    "event_time": mu["event_time"], "event_subtype": mu["type"].astype(str),
    "severity": sev, "label": mu["label_bin"], "time_is_synthetic": True,
})
mu_u["url"] = mu["url"]
mu_u = to_unified(mu_u, source_dataset="malicious_urls", event_domain="threat_intel",
                  event_type="ioc_url", label_type="ioc", attributes_cols=["url"])
save_clean(mu, "malicious_urls")
save_unified_part(mu_u, "malicious_urls")
dataset_report(mu, "malicious_urls", label_col="type", notes="651k labeled URLs incl. benign class; synthetic times.")

# %% [markdown]
# ## 3. Feodo Tracker — botnet C2 IPs

# %%
fd = pd.DataFrame(json.loads((D / "feodo_ipblocklist.json").read_text()))
fd["first_seen"] = pd.to_datetime(fd.get("first_seen_utc", fd.get("first_seen")), utc=True, errors="coerce")
fd = fd.dropna(subset=["first_seen"]).drop_duplicates(subset=["ip_address"]).reset_index(drop=True)
print(fd.shape); print(fd["malware"].value_counts())

# %%
fd_u = pd.DataFrame({
    "event_time": fd["first_seen"], "event_subtype": fd["malware"].astype(str).str.lower(),
    "src_ip": fd["ip_address"].astype(str), "dst_port": pd.to_numeric(fd.get("port"), errors="coerce").astype("Int32"),
    "country": fd.get("country"), "severity": 4, "label": 1, "time_is_synthetic": False,
})
attr = [c for c in ["hostname", "as_number", "as_name", "status", "last_online"] if c in fd.columns]
fd_u[attr] = fd[attr]
fd_u["severity"] = fd_u["severity"].astype("int8"); fd_u["label"] = fd_u["label"].astype("int8")
fd_u = to_unified(fd_u, source_dataset="feodo", event_domain="threat_intel",
                  event_type="ioc_ip", label_type="ioc", attributes_cols=attr)
save_clean(fd, "feodo")
save_unified_part(fd_u, "feodo")
dataset_report(fd, "feodo", label_col="malware", notes="Live C2 blocklist; all rows malicious.")

# %% [markdown]
# ## 4. CISA KEV — exploited CVEs (context rows, label=-1)

# %%
kev = pd.read_csv(D / "cisa_kev.csv")
kev["dateAdded"] = pd.to_datetime(kev["dateAdded"], utc=True, errors="coerce")
kev = kev.dropna(subset=["dateAdded"]).drop_duplicates(subset=["cveID"]).reset_index(drop=True)
print(kev.shape)
kev["knownRansomwareCampaignUse"].value_counts()

# %%
kev_u = pd.DataFrame({
    "event_time": kev["dateAdded"], "event_subtype": "cve_exploited",
    "severity": np.where(kev["knownRansomwareCampaignUse"].str.lower() == "known", 4, 3).astype("int8"),
    "label": -1, "time_is_synthetic": False,
})
attr = ["cveID", "vendorProject", "product", "vulnerabilityName", "knownRansomwareCampaignUse", "cwes"]
attr = [c for c in attr if c in kev.columns]
kev_u[attr] = kev[attr]
kev_u["label"] = kev_u["label"].astype("int8")
kev_u = to_unified(kev_u, source_dataset="cisa_kev", event_domain="threat_intel",
                   event_type="cve", label_type="ioc", attributes_cols=attr)
save_clean(kev, "cisa_kev")
save_unified_part(kev_u, "cisa_kev")
dataset_report(kev, "cisa_kev", notes="Authoritative exploited-CVE catalog; context rows label=-1.")

# %% [markdown]
# ## 5. MITRE ATT&CK Enterprise — technique reference table

# %%
stix = json.loads((D / "mitre_enterprise_attack.json").read_text())
rows = []
for o in stix["objects"]:
    if o.get("type") == "attack-pattern" and not o.get("revoked") and not o.get("x_mitre_deprecated"):
        ext = next((r for r in o.get("external_references", []) if r.get("source_name") == "mitre-attack"), {})
        rows.append({
            "technique_id": ext.get("external_id"),
            "name": o.get("name"),
            "tactics": ",".join(p["phase_name"] for p in o.get("kill_chain_phases", [])),
            "platforms": ",".join(o.get("x_mitre_platforms", [])),
            "created": o.get("created"), "is_subtechnique": o.get("x_mitre_is_subtechnique", False),
        })
mit = pd.DataFrame(rows).dropna(subset=["technique_id"]).drop_duplicates("technique_id").reset_index(drop=True)
mit["created"] = pd.to_datetime(mit["created"], utc=True, errors="coerce")
print(mit.shape); mit.head(3)

# %%
mit_u = pd.DataFrame({
    "event_time": mit["created"], "event_subtype": mit["tactics"].str.split(",").str[0],
    "attack_technique": mit["technique_id"], "severity": 2, "label": -1, "time_is_synthetic": False,
})
attr = ["name", "tactics", "platforms", "is_subtechnique"]
mit_u[attr] = mit[attr]
mit_u["severity"] = mit_u["severity"].astype("int8"); mit_u["label"] = mit_u["label"].astype("int8")
mit_u = to_unified(mit_u, source_dataset="mitre_attack", event_domain="threat_intel",
                   event_type="technique", label_type="ioc", attributes_cols=attr)
save_clean(mit, "mitre_attack")
save_unified_part(mit_u, "mitre_attack")
dataset_report(mit, "mitre_attack", notes="Enterprise ATT&CK techniques; reference/context rows label=-1.")
print("threat intel done")
