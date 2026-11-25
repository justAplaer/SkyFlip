"""DEMO_DATA path must resolve into this repo's frontend/public/demo-data."""

from pathlib import Path

from app.cache import DEMO_DATA, ROOT, demo_data_available


def test_demo_data_path_is_under_repo_frontend():
    expected = (ROOT / "frontend" / "public" / "demo-data").resolve()
    assert DEMO_DATA.resolve() == expected
    assert DEMO_DATA.exists(), f"Missing demo data dir: {DEMO_DATA}"


def test_demo_data_available_true():
    assert demo_data_available() is True
    # At least one target manifest should exist
    manifests = list(DEMO_DATA.glob("*/manifest.json"))
    assert len(manifests) >= 1
