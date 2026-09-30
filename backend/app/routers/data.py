"""
A/B. Data endpoints: receive PHC data -> validate -> clean -> store in SQL -> run the alert engine.
"""
import sqlite3
from datetime import date
from statistics import mean

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import config
from ..database import get_db, now_iso
from ..processing import Cleaner
from ..schemas import AddPHCIn, UpdateBedsIn, UpdatePatientsIn, UpdateStaffIn, UpdateStockIn
from ..security import current_user, ensure_district_access, ensure_phc_access, require_roles, scope_phc_ids
from ..services import alert_engine
from ..services.network import load_network
from ..services.risk import phc_risk, stock_status

router = APIRouter(prefix="/api", tags=["PHC data"])


def _active_alerts(conn, phc_id: str) -> list[dict]:
    rows = conn.execute("SELECT id, type, rule, severity, title, message FROM alerts WHERE status='active' AND phc_id=? "
                        "ORDER BY severity='warning', type", (phc_id,)).fetchall()
    return [dict(r) for r in rows]


def _after_update(conn, cleaner: Cleaner, phc_id: str, payload: dict) -> dict:
    """Common tail of every update: save the quality log, re-run the alert engine, build the response."""
    notes = cleaner.save()
    engine = alert_engine.evaluate(conn, [phc_id])
    return {"status": "ok", "phc_id": phc_id, **payload, "data_quality": notes,
            "alert_engine": engine, "active_alerts": _active_alerts(conn, phc_id)}


# ---------------------------------------------------------------- /add_phc
@router.post("/add_phc", summary="Register a new PHC", dependencies=[Depends(require_roles("admin", "district"))])
def add_phc(body: AddPHCIn, user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    district_id = body.district_id.upper()
    if not conn.execute("SELECT 1 FROM districts WHERE id=?", (district_id,)).fetchone():
        raise HTTPException(422, f"Unknown district '{body.district_id}'")
    ensure_district_access(user, district_id)

    cleaner = Cleaner(conn, "/add_phc", user)
    name = cleaner.phc_name(body.name)
    if conn.execute("SELECT 1 FROM phcs WHERE lower(name)=lower(?) AND district_id=?", (name, district_id)).fetchone():
        raise HTTPException(409, f"{name} already exists in {district_id}")
    if body.id:
        phc_id = body.id.upper()
        if not phc_id.startswith(district_id + "-"):
            raise HTTPException(422, f"PHC id must start with '{district_id}-'")
        if conn.execute("SELECT 1 FROM phcs WHERE id=?", (phc_id,)).fetchone():
            raise HTTPException(409, f"PHC id {phc_id} already exists")
    else:
        nums = [int(r["id"].split("-")[1]) for r in conn.execute("SELECT id FROM phcs WHERE district_id=?", (district_id,))]
        phc_id = f"{district_id}-{(max(nums) + 1 if nums else 1):02d}"
    cleaner.phc_id = phc_id
    occupied = cleaner.clamp("beds_occupied", body.beds_occupied, body.beds_total, "Occupied beds cannot exceed total beds")

    ts = now_iso()
    conn.execute(
        "INSERT INTO phcs (id, name, district_id, lat, lon, beds_total, beds_occupied, staff_total, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (phc_id, name, district_id, body.lat, body.lon, body.beds_total, occupied, body.staff_total, ts, ts))
    for item in body.initial_stock:
        med = cleaner.resolve_medicine(item.medicine)
        daily = item.daily_consumption or 0
        min_qty = item.min_qty if item.min_qty is not None else round(daily * config.MIN_STOCK_DAYS)
        conn.execute(
            "INSERT OR REPLACE INTO stock (phc_id, med_id, qty, min_qty, daily_consumption, expiry_date, batch, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (phc_id, med["id"], item.qty, min_qty, daily, item.expiry_date and item.expiry_date.isoformat(), item.batch, ts))
    return _after_update(conn, cleaner, phc_id, {"name": name, "district_id": district_id,
                                                  "medicines_registered": len(body.initial_stock)})


# ---------------------------------------------------------------- /update_stock
@router.post("/update_stock", summary="Update the stock of one medicine at a PHC")
def update_stock(body: UpdateStockIn, user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    ensure_phc_access(conn, user, body.phc_id)
    cleaner = Cleaner(conn, "/update_stock", user, body.phc_id)
    med = cleaner.resolve_medicine(body.medicine)
    existing = conn.execute("SELECT * FROM stock WHERE phc_id=? AND med_id=?", (body.phc_id, med["id"])).fetchone()
    day = (body.date or date.today()).isoformat()

    if body.dispensed_today is not None:
        conn.execute("INSERT INTO consumption_daily VALUES (?,?,?,?) ON CONFLICT(phc_id, med_id, date) DO UPDATE SET units=excluded.units",
                     (body.phc_id, med["id"], day, body.dispensed_today))
    if body.daily_consumption is not None:
        daily = body.daily_consumption
    elif body.dispensed_today is not None:
        rows = conn.execute("SELECT units FROM consumption_daily WHERE phc_id=? AND med_id=? ORDER BY date DESC LIMIT 7",
                            (body.phc_id, med["id"])).fetchall()
        daily = round(mean(r["units"] for r in rows), 1)
    else:
        daily = existing["daily_consumption"] if existing else 0

    if body.min_qty is not None:
        min_qty = body.min_qty
    elif existing:
        min_qty = existing["min_qty"]
    else:
        min_qty = cleaner.corrected("min_qty", None, round(daily * config.MIN_STOCK_DAYS),
                                    f"Minimum level defaulted to {config.MIN_STOCK_DAYS} days of consumption")

    if existing and existing["qty"] > 0 and body.qty > existing["qty"] * 10:
        cleaner.flagged("qty", body.qty, f"Stock jumped from {existing['qty']} to {body.qty}. Please verify the entry.")
    expiry = body.expiry_date.isoformat() if body.expiry_date else (existing["expiry_date"] if existing else None)
    if body.expiry_date and body.expiry_date < date.today():
        cleaner.flagged("expiry_date", expiry, "This batch has already expired")

    conn.execute(
        "INSERT INTO stock (phc_id, med_id, qty, min_qty, daily_consumption, expiry_date, batch, updated_at) VALUES (?,?,?,?,?,?,?,?) "
        "ON CONFLICT(phc_id, med_id) DO UPDATE SET qty=excluded.qty, min_qty=excluded.min_qty, "
        "daily_consumption=excluded.daily_consumption, expiry_date=excluded.expiry_date, "
        "batch=COALESCE(excluded.batch, stock.batch), updated_at=excluded.updated_at",
        (body.phc_id, med["id"], body.qty, min_qty, daily, expiry, body.batch, now_iso()))
    return _after_update(conn, cleaner, body.phc_id, {
        "medicine": {"med_id": med["id"], "name": med["name"]},
        "stock": {"qty": body.qty, "min_qty": min_qty, "daily_consumption": daily, "expiry_date": expiry},
    })


# ---------------------------------------------------------------- /update_beds
@router.post("/update_beds", summary="Update bed occupancy (and optionally total beds)")
def update_beds(body: UpdateBedsIn, user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    phc = ensure_phc_access(conn, user, body.phc_id)
    cleaner = Cleaner(conn, "/update_beds", user, body.phc_id)
    total = body.beds_total if body.beds_total is not None else phc["beds_total"]
    occupied = cleaner.clamp("beds_occupied", body.beds_occupied, total, f"Occupied beds cannot exceed total beds ({total})")
    conn.execute("UPDATE phcs SET beds_total=?, beds_occupied=?, updated_at=? WHERE id=?", (total, occupied, now_iso(), body.phc_id))
    return _after_update(conn, cleaner, body.phc_id, {"beds": {"total": total, "occupied": occupied, "available": total - occupied}})


# ---------------------------------------------------------------- /update_patients
@router.post("/update_patients", summary="Record the daily patient count (footfall)")
def update_patients(body: UpdatePatientsIn, user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    ensure_phc_access(conn, user, body.phc_id)
    cleaner = Cleaner(conn, "/update_patients", user, body.phc_id)
    day = (body.date or date.today()).isoformat()
    history = [r["patients"] for r in conn.execute(
        "SELECT patients FROM footfall_daily WHERE phc_id=? AND date<? ORDER BY date DESC LIMIT 28", (body.phc_id, day))]
    cleaner.outlier("patients", body.patients, history)
    conn.execute("INSERT INTO footfall_daily VALUES (?,?,?) ON CONFLICT(phc_id, date) DO UPDATE SET patients=excluded.patients",
                 (body.phc_id, day, body.patients))
    return _after_update(conn, cleaner, body.phc_id, {"date": day, "patients": body.patients})


# ---------------------------------------------------------------- /update_staff
@router.post("/update_staff", summary="Record daily staff attendance")
def update_staff(body: UpdateStaffIn, user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    phc = ensure_phc_access(conn, user, body.phc_id)
    cleaner = Cleaner(conn, "/update_staff", user, body.phc_id)
    total = body.total or phc["staff_total"]
    if body.total and body.total != phc["staff_total"]:
        conn.execute("UPDATE phcs SET staff_total=?, updated_at=? WHERE id=?", (total, now_iso(), body.phc_id))
    present = cleaner.clamp("present", body.present, total, f"Present staff cannot exceed total staff ({total})")
    day = (body.date or date.today()).isoformat()
    conn.execute("INSERT INTO staff_daily VALUES (?,?,?,?) ON CONFLICT(phc_id, date) DO UPDATE SET present=excluded.present, total=excluded.total",
                 (body.phc_id, day, present, total))
    return _after_update(conn, cleaner, body.phc_id, {"date": day, "staff": {"present": present, "total": total, "absent": total - present}})


# ---------------------------------------------------------------- /get_phc_data
def phc_view(net, phc, include_history: bool) -> dict:
    risk = phc_risk(phc, net.as_of)
    meds = []
    for mid, s in sorted(phc.stock.items()):
        st = stock_status(s, net.as_of)
        med = net.medicines[mid]
        row = {
            "med_id": mid, "name": med["name"], "unit": med["unit"], "category": med["category"],
            "qty": s.qty, "min_qty": s.min_qty, "daily_consumption": s.daily_consumption,
            "expiry_date": s.expiry.isoformat() if s.expiry else None, "batch": s.batch,
            "status": st["level"], "status_label": st["label"],
            "cover_days": None if st["cover_days"] == float("inf") else round(st["cover_days"], 1),
            "days_to_expiry": st["days_to_expiry"],
        }
        if include_history:
            row["consumption"] = s.consumption
        meds.append(row)
    out = {
        "id": phc.id, "name": phc.name, "district_id": phc.district_id,
        "district": net.districts[phc.district_id]["name"], "lat": phc.lat, "lon": phc.lon,
        "beds_total": phc.beds_total, "beds_occupied": phc.beds_occupied, "beds_available": phc.beds_total - phc.beds_occupied,
        "staff_total": phc.staff_total, "staff_present": phc.staff_present, "staff_absent": phc.staff_total - phc.staff_present,
        "patients_today": phc.footfall[-1] if phc.footfall else 0,
        "risk": {k: risk[k] for k in ("score", "level", "label", "reasons")},
        "medicines": meds,
    }
    if include_history:
        out["footfall"] = phc.footfall
        out["staff_history"] = phc.staff_history
    return out


@router.get("/get_phc_data", summary="PHC details: stock, beds, patients, staff (scoped to the user)")
def get_phc_data(phc_id: str | None = None,
                 include_history: bool = Query(False, description="Include 60-day daily series"),
                 user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    if phc_id:
        ensure_phc_access(conn, user, phc_id)
        ids = [phc_id]
    else:
        ids = scope_phc_ids(conn, user)
    net = load_network(conn, ids)
    return {
        "as_of": net.as_of.isoformat(),
        **({"dates": [d.isoformat() for d in net.dates]} if include_history else {}),
        "districts": list(net.districts.values()),
        "medicines": list(net.medicines.values()),
        "phcs": [phc_view(net, p, include_history) for p in net.phcs.values()],
    }


@router.get("/data_quality_log", summary="Recent cleaning corrections and flags",
            dependencies=[Depends(require_roles("admin", "district"))])
def data_quality_log(limit: int = Query(50, ge=1, le=500), user: dict = Depends(current_user),
                     conn: sqlite3.Connection = Depends(get_db)):
    ids = scope_phc_ids(conn, user)
    rows = conn.execute("SELECT * FROM data_quality_log ORDER BY id DESC LIMIT ?", (limit * 4,)).fetchall()
    return [dict(r) for r in rows if r["phc_id"] is None or r["phc_id"] in ids][:limit]
