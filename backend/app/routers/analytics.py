"""Dashboard, AI predictions, alerts, risk, redistribution and emergency simulation endpoints."""
import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from ..ai.forecasting import get_model
from ..ai.pipeline import Scenario, run_predictions, serialize
from ..database import get_db, now_iso
from ..schemas import DecisionIn, SimulationIn
from ..security import current_user, ensure_district_access, ensure_phc_access, require_roles, scope_phc_ids
from ..services import alert_engine
from ..services import redistribution as redis
from ..services.network import load_network
from ..services.risk import phc_risk, resilience_index, stock_status
from ..services.simulation import simulate

router = APIRouter(prefix="/api", tags=["Analytics & AI"])
HorizonQ = Query(14, description="Forecast horizon in days (7, 14 or 30)")


def _horizon(h: int) -> int:
    if h not in (7, 14, 30):
        raise HTTPException(422, "horizon must be 7, 14 or 30")
    return h


def _scoped_ids(conn, user, district_id: str | None) -> list[str]:
    if district_id:
        ensure_district_access(user, district_id)
        return [r["id"] for r in conn.execute("SELECT id FROM phcs WHERE district_id=? ORDER BY id", (district_id,))]
    return scope_phc_ids(conn, user)


# ---------------------------------------------------------------- /get_dashboard
@router.get("/get_dashboard", summary="National / district KPIs, trends and top risks")
def get_dashboard(district_id: str | None = None, user: dict = Depends(current_user),
                  conn: sqlite3.Connection = Depends(get_db)):
    if user["role"] == "phc":
        raise HTTPException(403, "The dashboard is for admins and district officers")
    ids = _scoped_ids(conn, user, district_id)
    net = load_network(conn, ids)
    phcs = list(net.phcs.values())
    if not phcs:
        raise HTTPException(404, "No PHCs in scope")
    risks = {p.id: phc_risk(p, net.as_of) for p in phcs}
    stocks = [s for p in phcs for s in p.stock.values()]
    n = len(net.dates)
    total_series = [sum(p.footfall[i] for p in phcs) for i in range(n)]
    fc = get_model().fit(total_series).predict(7)
    beds_t, beds_o = sum(p.beds_total for p in phcs), sum(p.beds_occupied for p in phcs)
    staff_t, staff_p = sum(p.staff_total for p in phcs), sum(p.staff_present for p in phcs)
    ph = ",".join("?" * len(ids))
    crit_alerts = conn.execute(
        f"SELECT COUNT(*) FROM alerts WHERE status='active' AND severity='critical' AND acked_at IS NULL AND phc_id IN ({ph})", ids
    ).fetchone()[0]

    by_district = {}
    for p in phcs:
        by_district.setdefault(p.district_id, []).append(p)
    districts = []
    for did, ps in sorted(by_district.items()):
        rs = [risks[p.id] for p in ps]
        districts.append({
            "district_id": did, "name": net.districts[did]["name"], "state": net.districts[did]["state"],
            "phcs": len(ps), "patients_today": sum(p.footfall[-1] for p in ps),
            "bed_occupancy": round(sum(p.beds_occupied for p in ps) / max(1, sum(p.beds_total for p in ps)), 3),
            "staff_attendance": round(sum(p.staff_present for p in ps) / max(1, sum(p.staff_total for p in ps)), 3),
            "stockouts": sum(1 for p in ps for s in p.stock.values() if s.qty <= 0),
            "high_risk_phcs": sum(r["level"] == "critical" for r in rs),
            "resilience_index": resilience_index(rs),
        })

    top = sorted(risks.values(), key=lambda r: -r["score"])[:5]
    return {
        "as_of": net.as_of.isoformat(),
        "scope": district_id or ({"admin": "national", "district": user["district_id"]}[user["role"]]),
        "resilience_index": resilience_index(list(risks.values())),
        "kpis": {
            "total_phcs": len(phcs),
            "total_medicine_units": sum(s.qty for s in stocks),
            "beds_total": beds_t, "beds_occupied": beds_o, "beds_available": beds_t - beds_o,
            "patients_today": total_series[-1], "patients_yesterday": total_series[-2],
            "staff_total": staff_t, "staff_present": staff_p, "staff_attendance": round(staff_p / max(1, staff_t), 3),
            "phcs_at_risk": sum(r["level"] == "critical" for r in risks.values()),
            "phcs_moderate_risk": sum(r["level"] == "warning" for r in risks.values()),
            "current_stockouts": sum(1 for s in stocks if s.qty <= 0),
            "critical_medicine_lines": sum(1 for s in stocks if stock_status(s, net.as_of)["level"] == "critical"),
            "open_critical_alerts": crit_alerts,
        },
        "footfall_trend": {
            "dates": [d.isoformat() for d in net.dates[-30:]], "actual": total_series[-30:],
            "forecast": [{"mean": round(f.mean), "lo": round(f.lo), "hi": round(f.hi)} for f in fc],
        },
        "top_risk_phcs": [{**r, "name": net.phcs[r["phc_id"]].name,
                           "district": net.districts[net.phcs[r["phc_id"]].district_id]["name"]} for r in top],
        "districts": districts,
    }


# ---------------------------------------------------------------- /get_predictions
@router.get("/get_predictions", summary="AI demand forecast, expected stock-out dates and risk %")
def get_predictions(phc_id: str | None = None, horizon: int = HorizonQ,
                    min_risk: int = Query(0, ge=0, le=100, description="Only medicines with risk >= this (multi-PHC mode)"),
                    user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    h = _horizon(horizon)
    if phc_id:
        ensure_phc_access(conn, user, phc_id)
        net = load_network(conn, [phc_id])
        pred = run_predictions(conn, net, [phc_id], h)[phc_id]
        return serialize(pred, net)
    ids = scope_phc_ids(conn, user)
    net = load_network(conn, ids)
    preds = run_predictions(conn, net, ids, h)
    out = []
    for pid, pred in preds.items():
        s = serialize(pred, net, include_daily=False)
        s["medicines"] = [m for m in s["medicines"] if m["risk_percent"] >= min_risk]
        del s["patients"]["daily"]
        out.append(s)
    return {"horizon": h, "as_of": net.as_of.isoformat(), "phcs": out}


# ---------------------------------------------------------------- /get_risk
@router.get("/get_risk", summary="Explainable PHC risk scores and the Resilience Index")
def get_risk(phc_id: str | None = None, district_id: str | None = None, user: dict = Depends(current_user),
             conn: sqlite3.Connection = Depends(get_db)):
    if phc_id:
        ensure_phc_access(conn, user, phc_id)
        ids = [phc_id]
    else:
        ids = _scoped_ids(conn, user, district_id)
    net = load_network(conn, ids)
    risks = [{**phc_risk(p, net.as_of), "name": p.name, "district_id": p.district_id} for p in net.phcs.values()]
    return {"as_of": net.as_of.isoformat(), "resilience_index": resilience_index(risks),
            "phcs": sorted(risks, key=lambda r: -r["score"])}


# ---------------------------------------------------------------- /get_alerts
@router.get("/get_alerts", summary="Alerts produced by the alert engine")
def get_alerts(type: Literal["stock", "bed", "staff", "emergency", "expiry"] | None = None,
               severity: Literal["critical", "warning"] | None = None,
               phc_id: str | None = None,
               include_acknowledged: bool = False, include_resolved: bool = False,
               user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    if phc_id:
        ensure_phc_access(conn, user, phc_id)
        ids = [phc_id]
    else:
        ids = scope_phc_ids(conn, user)
    if not ids:
        return {"count": 0, "alerts": []}
    sql = (f"SELECT a.*, p.name AS phc_name, d.name AS district FROM alerts a JOIN phcs p ON p.id=a.phc_id "
           f"JOIN districts d ON d.id=p.district_id WHERE a.phc_id IN ({','.join('?' * len(ids))})")
    params: list = list(ids)
    if not include_resolved:
        sql += " AND a.status='active'"
    if not include_acknowledged:
        sql += " AND a.acked_at IS NULL"
    if type:
        sql += " AND a.type=?"
        params.append(type)
    if severity:
        sql += " AND a.severity=?"
        params.append(severity)
    sql += (" ORDER BY a.severity='warning', CASE a.type WHEN 'emergency' THEN 0 WHEN 'stock' THEN 1 WHEN 'bed' THEN 2 "
            "WHEN 'staff' THEN 3 ELSE 4 END, a.created_at DESC")
    rows = [dict(r) for r in conn.execute(sql, params)]
    return {"count": len(rows), "alerts": rows}


@router.post("/alerts/{alert_id}/ack", summary="Acknowledge an alert")
def ack_alert(alert_id: str, user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    row = conn.execute("SELECT phc_id FROM alerts WHERE id=?", (alert_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Alert not found")
    ensure_phc_access(conn, user, row["phc_id"])
    conn.execute("UPDATE alerts SET acked_by=?, acked_at=? WHERE id=?", (user["username"], now_iso(), alert_id))
    return {"id": alert_id, "acknowledged": True}


# ---------------------------------------------------------------- /get_redistribution
def _involves(t: dict, user: dict, district_id: str | None) -> bool:
    ends = (t["from_phc"], t["to_phc"])
    if user["role"] == "admin":
        return not district_id or any(e["district_id"] == district_id for e in ends)
    if user["role"] == "district":
        return any(e["district_id"] == user["district_id"] for e in ends)
    return any(e["id"] == user["phc_id"] for e in ends)


def _can_approve(t: dict, user: dict) -> bool:
    if user["role"] == "admin":
        return True
    return user["role"] == "district" and any(e["district_id"] == user["district_id"] for e in (t["from_phc"], t["to_phc"]))


def _plan(conn, horizon, patient_increase=0.0, medicine_increase=0.0):
    net = load_network(conn)   # planning always uses the whole network: donors can be in any district
    sc = Scenario(patient_increase, medicine_increase)
    decided = {r["id"] for r in conn.execute("SELECT id FROM transfers")}
    return [t for t in redis.plan(net, horizon, sc) if t["id"] not in decided]


@router.get("/get_redistribution", summary="Recommended cross-district transfers (PHC A -> PHC B)")
def get_redistribution(horizon: int = HorizonQ,
                       patient_increase: float = Query(0, ge=0, le=500, description="Scenario: % more patients"),
                       medicine_increase: float = Query(0, ge=0, le=500, description="Scenario: % more medicine per patient"),
                       priority: Literal["HIGH", "MEDIUM", "LOW"] | None = None,
                       district_id: str | None = None,
                       user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    h = _horizon(horizon)
    plan = [t for t in _plan(conn, h, patient_increase, medicine_increase) if _involves(t, user, district_id)]
    for t in plan:
        t["can_approve"] = _can_approve(t, user)
    shown = [t for t in plan if not priority or t["priority"] == priority]
    return {
        "horizon": h,
        "scenario": {"patient_increase": patient_increase, "medicine_increase": medicine_increase},
        "summary": {
            "transfers": len(plan),
            "by_priority": {p: sum(t["priority"] == p for t in plan) for p in ("HIGH", "MEDIUM", "LOW")},
            "units": sum(t["quantity"] for t in plan),
            "phcs_protected": len({t["to_phc"]["id"] for t in plan}),
            "cross_district": sum(t["cross_district"] for t in plan),
            "near_expiry_units": sum(t["quantity"] for t in plan if t["near_expiry"]),
        },
        "transfers": shown,
    }


@router.post("/redistribution/decision", summary="Approve or reject a recommended transfer",
             dependencies=[Depends(require_roles("admin", "district"))])
def decide(body: DecisionIn, user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    # Recompute the plan on the server so quantities can't be tampered with by the client
    plan = _plan(conn, body.horizon, body.patient_increase, body.medicine_increase)
    t = next((x for x in plan if x["id"] == body.transfer_id), None)
    if not t:
        raise HTTPException(404, "Transfer not in the current plan (already decided or no longer needed)")
    if not _can_approve(t, user):
        raise HTTPException(403, "You can only decide transfers that involve your district")
    result = redis.apply_decision(conn, t, body.status, user["username"])
    alert_engine.evaluate(conn, [t["from_phc"]["id"], t["to_phc"]["id"]])
    return {**result, "transfer": t}


@router.get("/transfers", summary="Decision log (approved / rejected transfers)")
def transfers(user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    rows = conn.execute(
        "SELECT t.*, m.name AS medicine, m.unit, pf.name AS from_name, pf.district_id AS from_district, "
        "pt.name AS to_name, pt.district_id AS to_district FROM transfers t "
        "JOIN medicines m ON m.id=t.med_id JOIN phcs pf ON pf.id=t.from_phc JOIN phcs pt ON pt.id=t.to_phc "
        "ORDER BY t.decided_at DESC").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        view = {"from_phc": {"id": d["from_phc"], "district_id": d["from_district"]},
                "to_phc": {"id": d["to_phc"], "district_id": d["to_district"]}}
        if _involves(view, user, None):
            out.append(d)
    return out


# ---------------------------------------------------------------- /simulate
@router.post("/simulate", summary="F. Emergency simulation: run the AI models under simulated conditions",
             dependencies=[Depends(require_roles("admin", "district"))])
def run_simulation(body: SimulationIn, user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    ids = _scoped_ids(conn, user, body.district_id)
    net = load_network(conn, ids)
    sc = Scenario(body.patient_increase, body.medicine_increase, body.staff_reduction, body.bed_increase)
    result = simulate(conn, net, ids, sc, body.horizon)
    if body.include_redistribution:
        plan = [t for t in _plan(conn, body.horizon, body.patient_increase, body.medicine_increase)
                if _involves(t, user, body.district_id)]
        result["redistribution"] = {"transfers": len(plan), "units": sum(t["quantity"] for t in plan), "plan": plan[:50]}
    return result
