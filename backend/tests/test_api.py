"""End-to-end API tests. Run from backend/:  python -m pytest -q"""
import os
import tempfile
from datetime import date, timedelta
from pathlib import Path

os.environ["PULSEGRID_DB"] = str(Path(tempfile.mkdtemp()) / "test.db")
os.environ["PULSEGRID_SECRET"] = "test-secret"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def token(client, username, password):
    r = client.post("/api/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture(scope="module")
def admin(client):
    return token(client, "admin", "admin123")


@pytest.fixture(scope="module")
def dho(client):
    return token(client, "dho.patna", "dho123")


@pytest.fixture(scope="module")
def phc(client):
    return token(client, "phc.danapur", "phc123")


# ---------------- C. Authentication ----------------
def test_login_wrong_password(client):
    assert client.post("/api/login", json={"username": "admin", "password": "nope"}).status_code == 401


def test_requires_token(client):
    assert client.get("/api/get_dashboard").status_code == 401


def test_bad_token(client):
    assert client.get("/api/me", headers={"Authorization": "Bearer abc"}).status_code == 401


def test_me(client, dho):
    me = client.get("/api/me", headers=dho).json()
    assert me["role"] == "district" and me["district_id"] == "PAT"


def test_role_scoping(client, admin, dho, phc):
    assert len(client.get("/api/get_phc_data", headers=admin).json()["phcs"]) == 30
    assert {p["district_id"] for p in client.get("/api/get_phc_data", headers=dho).json()["phcs"]} == {"PAT"}
    assert [p["id"] for p in client.get("/api/get_phc_data", headers=phc).json()["phcs"]] == ["PAT-01"]


def test_access_permissions(client, dho, phc):
    assert client.get("/api/get_phc_data?phc_id=PUN-01", headers=dho).status_code == 403
    assert client.post("/api/update_beds", json={"phc_id": "PAT-02", "beds_occupied": 1}, headers=phc).status_code == 403
    assert client.get("/api/get_dashboard", headers=phc).status_code == 403
    assert client.post("/api/simulate", json={}, headers=phc).status_code == 403
    assert client.post("/api/admin/reseed", headers=dho).status_code == 403
    assert client.post("/api/add_phc", headers=dho, json={
        "name": "Test Centre", "district_id": "PUN", "lat": 18, "lon": 73, "beds_total": 4, "staff_total": 4}).status_code == 403


# ---------------- A/B. Data APIs, validation & cleaning ----------------
def test_add_phc_with_cleaning(client, dho):
    r = client.post("/api/add_phc", headers=dho, json={
        "name": "  phc   new  colony ", "district_id": "pat", "lat": 25.6, "lon": 85.1,
        "beds_total": 10, "beds_occupied": 14, "staff_total": 8,
        "initial_stock": [{"medicine": "paracetamol", "qty": "1,200", "daily_consumption": 40}]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["phc_id"] == "PAT-06" and body["name"] == "PHC New Colony"
    fields = {n["field"] for n in body["data_quality"]}
    assert {"name", "beds_occupied", "medicine"} <= fields
    data = client.get("/api/get_phc_data?phc_id=PAT-06", headers=dho).json()["phcs"][0]
    assert data["beds_occupied"] == 10
    assert data["medicines"][0]["qty"] == 1200 and data["medicines"][0]["min_qty"] == 400


def test_validation_rejects_bad_input(client, admin):
    future = (date.today() + timedelta(days=2)).isoformat()
    assert client.post("/api/update_patients", headers=admin, json={"phc_id": "PAT-01", "patients": -5}).status_code == 422
    assert client.post("/api/update_patients", headers=admin, json={"phc_id": "PAT-01", "patients": 10, "date": future}).status_code == 422
    assert client.post("/api/update_stock", headers=admin, json={"phc_id": "PAT-01", "medicine": "unobtainium", "qty": 5}).status_code == 422
    assert client.post("/api/update_beds", headers=admin, json={"phc_id": "NOPE-1", "beds_occupied": 1}).status_code == 404


def test_update_patients_flags_outlier(client, phc):
    r = client.post("/api/update_patients", headers=phc, json={"phc_id": "PAT-01", "patients": 4000})
    assert r.status_code == 200
    assert r.json()["data_quality"][0]["action"] == "flagged"
    client.post("/api/update_patients", headers=phc, json={"phc_id": "PAT-01", "patients": 210})


def test_update_staff_clamps(client, phc):
    r = client.post("/api/update_staff", headers=phc, json={"phc_id": "PAT-01", "present": 25, "total": 20})
    assert r.status_code == 200 and r.json()["staff"]["present"] == 20


# ---------------- D. Alert engine ----------------
def test_alert_rules(client, admin):
    # Stock < minimum level -> alert
    r = client.post("/api/update_stock", headers=admin, json={
        "phc_id": "PUN-01", "medicine": "M03", "qty": 5, "min_qty": 500, "daily_consumption": 10})
    ids = {a["id"] for a in r.json()["active_alerts"]}
    assert "stock_min:PUN-01:M03" in ids
    # Predicted demand > available stock -> stock-out warning
    r = client.post("/api/update_stock", headers=admin, json={
        "phc_id": "PUN-01", "medicine": "M03", "qty": 50, "min_qty": 10, "daily_consumption": 60})
    alerts = {a["id"]: a for a in r.json()["active_alerts"]}
    assert "stock_forecast:PUN-01:M03" in alerts and "stock_min:PUN-01:M03" not in alerts
    assert alerts["stock_forecast:PUN-01:M03"]["rule"] == "predicted_stockout"
    # Refill -> alert resolves automatically
    r = client.post("/api/update_stock", headers=admin, json={
        "phc_id": "PUN-01", "medicine": "M03", "qty": 50000, "min_qty": 10, "daily_consumption": 60})
    assert not any(a["id"].endswith("PUN-01:M03") and a["type"] == "stock" for a in r.json()["active_alerts"])
    resolved = client.get("/api/get_alerts?phc_id=PUN-01&include_resolved=true&include_acknowledged=true", headers=admin).json()
    assert any(a["id"] == "stock_forecast:PUN-01:M03" and a["status"] == "resolved" for a in resolved["alerts"])


def test_bed_alert_and_ack(client, admin):
    r = client.post("/api/update_beds", headers=admin, json={"phc_id": "ERN-02", "beds_occupied": 500})
    assert r.json()["beds"]["occupied"] == r.json()["beds"]["total"]
    assert "bed:ERN-02" in {a["id"] for a in r.json()["active_alerts"]}
    assert client.post("/api/alerts/bed:ERN-02/ack", headers=admin).status_code == 200
    open_ids = {a["id"] for a in client.get("/api/get_alerts?type=bed", headers=admin).json()["alerts"]}
    assert "bed:ERN-02" not in open_ids


def test_emergency_alert_from_surge(client, admin):
    alerts = client.get("/api/get_alerts?type=emergency", headers=admin).json()["alerts"]
    assert {"emergency:PAT-01", "emergency:KAM-01"} <= {a["id"] for a in alerts}


# ---------------- E. AI integration ----------------
@pytest.mark.parametrize("h", [7, 14, 30])
def test_predictions(client, dho, h):
    p = client.get(f"/api/get_predictions?phc_id=PAT-02&horizon={h}", headers=dho).json()
    assert len(p["patients"]["daily"]) == h and len(p["medicines"]) == 12
    m = p["medicines"][0]
    assert {"predicted_demand", "expected_stockout_date", "risk_percent"} <= set(m)
    assert 0 <= m["risk_percent"] <= 100 and p["backtest_mape"] < 25


def test_prediction_bad_horizon(client, dho):
    assert client.get("/api/get_predictions?phc_id=PAT-02&horizon=9", headers=dho).status_code == 422


def test_outbreak_forecast_follows_surge(client, admin):
    p = client.get("/api/get_predictions?phc_id=KAM-01&horizon=7", headers=admin).json()
    history = client.get("/api/get_phc_data?phc_id=KAM-01&include_history=true", headers=admin).json()["phcs"][0]["footfall"]
    baseline = sum(history[-31:-3]) / 28
    assert p["patients"]["total"] / 7 > baseline * 1.2


def test_dashboard_and_risk(client, admin, dho):
    d = client.get("/api/get_dashboard", headers=admin).json()
    assert d["kpis"]["total_phcs"] == 31 and 0 <= d["resilience_index"] <= 100
    assert len(d["footfall_trend"]["forecast"]) == 7
    assert client.get("/api/get_dashboard?district_id=PUN", headers=dho).status_code == 403
    r = client.get("/api/get_risk?phc_id=PAT-01", headers=dho).json()
    assert r["phcs"][0]["level"] in {"critical", "warning", "normal"} and len(r["phcs"][0]["parts"]) == 4


# ---------------- F. Simulation + G. Redistribution ----------------
def test_simulation_is_monotonic(client, admin):
    base = client.post("/api/simulate", headers=admin, json={"horizon": 14}).json()["summary"]
    storm = client.post("/api/simulate", headers=admin, json={
        "patient_increase": 90, "medicine_increase": 50, "staff_reduction": 30, "bed_increase": 120, "horizon": 14}).json()["summary"]
    assert storm["critical"] >= base["critical"] and storm["shortage_lines"] > base["shortage_lines"]
    assert storm["required_beds"] > 0 and storm["required_staff"] > 0


def test_simulation_validation(client, admin):
    assert client.post("/api/simulate", headers=admin, json={"staff_reduction": 150}).status_code == 422


def test_redistribution_approve_moves_stock(client, admin, dho, phc):
    plan = client.get("/api/get_redistribution?horizon=14", headers=dho).json()
    assert plan["transfers"], "expected at least one transfer involving Patna"
    t = next(x for x in plan["transfers"] if x["can_approve"])
    assert t["from_phc"]["id"] != t["to_phc"]["id"] and t["quantity"] > 0

    def qty(pid):
        d = client.get(f"/api/get_phc_data?phc_id={pid}", headers=admin).json()["phcs"][0]
        return next(m["qty"] for m in d["medicines"] if m["med_id"] == t["med_id"])

    before_from, before_to = qty(t["from_phc"]["id"]), qty(t["to_phc"]["id"])
    decision = {"transfer_id": t["id"], "status": "approved", "horizon": 14}
    assert client.post("/api/redistribution/decision", headers=phc, json=decision).status_code == 403
    r = client.post("/api/redistribution/decision", headers=dho, json=decision)
    assert r.status_code == 200, r.text
    assert qty(t["from_phc"]["id"]) == before_from - t["quantity"]
    assert qty(t["to_phc"]["id"]) == before_to + t["quantity"]
    assert client.post("/api/redistribution/decision", headers=dho, json=decision).status_code == 404
    log = client.get("/api/transfers", headers=dho).json()
    assert log[0]["id"] == t["id"] and log[0]["status"] == "approved"


def test_prediction_runs_are_logged(client, admin):
    from app.database import connect
    c = connect()
    assert c.execute("SELECT COUNT(*) FROM prediction_runs").fetchone()[0] > 0
    assert c.execute("SELECT COUNT(*) FROM data_quality_log").fetchone()[0] > 0
    c.close()
