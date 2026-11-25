import time
from types import SimpleNamespace
import numpy as np
import pytest
from astropy.wcs import WCS
from fastapi.testclient import TestClient
from app import batches, main
from app.adapters.spherex import SpherexAdapter, SpherexObservation

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SKYFLIP_OBSERVATIONS_DB", str(tmp_path / "db.sqlite"))
    monkeypatch.setattr(main, "cache_root", lambda: tmp_path)
    w = WCS(naxis=2); w.wcs.crpix=[5,5]; w.wcs.cdelt=[-.001,.001]; w.wcs.crval=[133.795,-7.245]; w.wcs.ctype=["RA---TAN","DEC--TAN"]
    observations=[SpherexObservation(obs_id=f"o{i}",bandpass="SPHEREx-D1",detector=1,mjd=60000+i,access_url=f"https://irsa.ipac.caltech.edu/ibe/data/spherex/o{i}.fits",cutout_url=f"https://irsa.ipac.caltech.edu/ibe/data/spherex/o{i}.fits",collection="spherex_dr1") for i in range(22)]
    monkeypatch.setattr(SpherexAdapter,"find_observations",lambda *a,**k: observations)
    def fetch(self,o,**kw):
        if o.obs_id=="o2": raise ValueError("simulated image failure")
        return SimpleNamespace(image=np.arange(100).reshape(10,10), wcs=w, flag_summary={}, central_wavelength_um=1.0, header_meta={})
    monkeypatch.setattr(SpherexAdapter,"fetch_cutout",fetch)
    monkeypatch.setattr(main,"_ensure_frame_pyramid",lambda o,**kw: {"shape":[2048,2048],"wcs":{},"stats":{}})
    with TestClient(main.app) as c: yield c

def wait(client, req):
    r=client.post("/api/batches",json=req); assert r.status_code==202,r.text
    ident=r.json()["batch_id"]
    for i in range(300):
        b=client.get("/api/batches/"+ident).json()
        if b["status"] not in ("queued","running"): return b
        time.sleep(.05)
    pytest.fail("batch did not finish")

def test_batches_and_report(client):
    req={"ra":133.795,"dec":-7.245,"fov":.1,"detector":1,"view_mode":"target_crop","idempotency_key":"batch-test-001"}
    b=wait(client,req)
    assert b["status"]=="ready",b
    assert len(b["data"]["frames"])==10 and len(b["failures"])==1
    assert [f["mjd"] for f in b["data"]["frames"]]==sorted(f["mjd"] for f in b["data"]["frames"])
    assert client.get("/api/batches/"+b["batch_id"]).json()["data"]==b["data"]
    assert client.get("/api/batches/"+b["batch_id"]+"/frames/0").status_code==200
    frames=b["data"]["frames"][:2]
    body={"idempotency_key":"report-test-001","description":"A faint point moved between the frames.","context":{"ra":req["ra"],"dec":req["dec"],"batch_id":b["batch_id"],"image_mode":"target_crop"},"frames":frames,"highlights":[{"epoch_id":f["epoch_id"],"pixel":{"x0":1,"y0":1,"x1":3,"y1":3}} for f in frames],"answers":{"direction":"not_sure","confidence":3},"form_ms":5000}
    report=client.post("/api/observations",json=body); assert report.status_code==201,report.text
    from app.observations.db import connect
    with connect() as conn:
        row=conn.execute("select payload_json from observation_submissions where submission_id=?",(report.json()["submission_id"],)).fetchone()
        assert b["batch_id"] in row[0]
    req["idempotency_key"]="batch-test-002"; req["view_mode"]="full_frame"
    full=wait(client,req); assert full["status"]=="ready",full
    assert all(f["view_mode"]=="full_frame" for f in full["data"]["frames"])
    assert client.post("/api/batches",json={**req,"ra":361}).status_code==422
    assert client.get("/api/status").status_code==200

def test_archive_failure(client,monkeypatch):
    def fail(*a,**kw): raise RuntimeError("archive unavailable")
    monkeypatch.setattr(SpherexAdapter,"find_observations",fail)
    b=wait(client,{"ra":1,"dec":1,"idempotency_key":"batch-fail-1"})
    assert b["status"]=="failed" and b["error"]["kind"]=="external_data"
    assert client.get("/api/status").status_code==200
