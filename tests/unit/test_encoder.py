import json

import numpy as np
import pandas as pd
import pytest

from ml.features import CategoryEncoder


@pytest.fixture
def frame():
    return pd.DataFrame({"proto": ["tcp", "udp", "tcp", None, "icmp"],
                         "kind": ["a", "a", "b", "b", None]})


def test_fit_freezes_sorted_vocab(frame):
    enc = CategoryEncoder().fit(frame, ["proto"])
    assert enc.mapping["proto"] == {"icmp": 0, "tcp": 1, "udp": 2}


def test_unseen_category_maps_to_minus1(frame):
    enc = CategoryEncoder().fit(frame, ["proto"])
    out = enc.transform(pd.DataFrame({"proto": ["quic", "tcp"]}))
    assert out["proto"].tolist() == [-1.0, 1.0]


def test_nan_category_maps_to_minus1(frame):
    enc = CategoryEncoder().fit(frame, ["proto"])
    out = enc.transform(pd.DataFrame({"proto": [None, "udp"]}))
    assert out["proto"].tolist() == [-1.0, 2.0]


def test_missing_column_transforms_to_all_minus1(frame):
    enc = CategoryEncoder().fit(frame, ["proto", "kind"])
    out = enc.transform(pd.DataFrame({"proto": ["tcp"]}))  # no `kind` column
    assert out["kind"].tolist() == [-1.0]


def test_mapping_json_roundtrip(frame):
    enc = CategoryEncoder().fit(frame, ["proto", "kind"])
    clone = CategoryEncoder(json.loads(json.dumps(enc.mapping)))
    probe = pd.DataFrame({"proto": ["tcp", "x", None], "kind": ["b", None, "a"]})
    pd.testing.assert_frame_equal(enc.transform(probe), clone.transform(probe))


def test_transform_dtype_float32(frame):
    enc = CategoryEncoder().fit(frame, ["proto"])
    out = enc.transform(frame)
    assert out["proto"].dtype == np.float32
