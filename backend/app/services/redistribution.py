"""
G. Cross-district redistribution planner.

Greedy matching per medicine: the most urgent receivers are served first, and the
cheapest donor is used first. Cost is road distance, discounted when the donor's
stock is close to expiry (it would otherwise be wasted) and for same-district
donors. Each donor keeps its own horizon demand plus its minimum stock level.
"""
from __future__ import annotations

import math
import sqlite3

from fastapi import HTTPException

from .. import config
from ..ai.pipeline import Scenario, run_predictions
from ..database import now_iso
from .network import Network


def haversine_km(a, b) -> float:
    r = math.radians
    dlat, dlon = r(b.lat - a.lat), r(b.lon - a.lon)
    h = math.sin(dlat / 2) ** 2 + math.cos(r(a.lat)) * math.cos(r(b.lat)) * math.sin(dlon / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def plan(net: Network, horizon: int, scenario: Scenario | None = None) -> list[dict]:
    preds = run_predictions(None, net, list(net.phcs), horizon, scenario, log=False)
    out = []
    for mid, med in net.medicines.items():
        receivers, donors = [], []
        for pid, pred in preds.items():
            m = pred.meds.get(mid)
            if not m:
                continue
            s = m.stock
            if s.qty < m.total:
                receivers.append({"phc": pred.phc, "s": s, "need": math.ceil(m.total + s.min_qty * 0.5 - s.qty),
                                  "day": m.stockout_day, "demand": m.total})
            else:
                surplus = math.floor(s.qty - m.total - s.min_qty)
                if surplus > 0:
                    dte = (s.expiry - net.as_of).days if s.expiry else 9999
                    donors.append({"phc": pred.phc, "s": s, "surplus": surplus, "near_expiry": dte < 60, "dte": dte})
        receivers.sort(key=lambda r: r["day"])
        for rc in receivers:
            need = rc["need"]
            ranked = []
            for d in donors:
                if d["surplus"] <= 0:
                    continue
                km = haversine_km(d["phc"], rc["phc"]) * config.ROAD_FACTOR
                cost = km * (0.5 if d["near_expiry"] else 1) * (0.8 if d["phc"].district_id == rc["phc"].district_id else 1)
                ranked.append((cost, km, d))
            ranked.sort(key=lambda x: x[0])
            for _, km, d in ranked:
                if need <= 0:
                    break
                qty = min(need, d["surplus"])
                if qty >= 50:
                    qty = qty // 10 * 10
                if qty < max(2, rc["s"].daily_consumption):
                    continue
                d["surplus"] -= qty
                need -= qty
                day = rc["day"]
                priority = "HIGH" if day <= 3 else "MEDIUM" if day <= 7 else "LOW"
                why = ["Already out of stock" if rc["s"].qty <= 0 else f"Predicted stock-out in {day:.1f} days",
                       f"{horizon}-day demand {round(rc['demand']):,} vs stock {rc['s'].qty:,}"]
                if d["near_expiry"]:
                    why.append(f"donor batch expires in {d['dte']} days, which prevents wastage")
                fp, tp = d["phc"], rc["phc"]
                out.append({
                    "id": f"{mid}_{fp.id}_{tp.id}",
                    "med_id": mid, "medicine": med["name"], "unit": med["unit"],
                    "from_phc": {"id": fp.id, "name": fp.name, "district_id": fp.district_id,
                                 "district": net.districts[fp.district_id]["name"]},
                    "to_phc": {"id": tp.id, "name": tp.name, "district_id": tp.district_id,
                               "district": net.districts[tp.district_id]["name"]},
                    "quantity": int(qty), "priority": priority,
                    "stockout_in_days": round(day, 1), "distance_km": round(km, 1),
                    "eta_hours": round(km / config.TRUCK_KMPH, 1),
                    "near_expiry": d["near_expiry"], "cross_district": fp.district_id != tp.district_id,
                    "short_reason": "Stock-out" if rc["s"].qty <= 0 else "Predicted shortage",
                    "reason": "; ".join(why),
                })
    order = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
    return sorted(out, key=lambda t: (order[t["priority"]], t["stockout_in_days"]))


def apply_decision(conn: sqlite3.Connection, t: dict, status: str, username: str) -> dict:
    """Record a decision. An approval moves stock from the donor to the receiver in one transaction."""
    if conn.execute("SELECT 1 FROM transfers WHERE id = ?", (t["id"],)).fetchone():
        raise HTTPException(409, "A decision has already been recorded for this transfer")
    qty = int(t["quantity"])
    if status == "approved":
        donor = conn.execute("SELECT qty FROM stock WHERE phc_id=? AND med_id=?", (t["from_phc"]["id"], t["med_id"])).fetchone()
        if not donor or donor["qty"] < qty:
            raise HTTPException(409, "Donor PHC no longer has enough stock. Refresh the plan.")
        ts = now_iso()
        conn.execute("UPDATE stock SET qty = qty - ?, updated_at=? WHERE phc_id=? AND med_id=?", (qty, ts, t["from_phc"]["id"], t["med_id"]))
        conn.execute("UPDATE stock SET qty = qty + ?, updated_at=? WHERE phc_id=? AND med_id=?", (qty, ts, t["to_phc"]["id"], t["med_id"]))
    conn.execute(
        "INSERT INTO transfers (id, med_id, from_phc, to_phc, qty, priority, km, reason, status, decided_by, decided_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (t["id"], t["med_id"], t["from_phc"]["id"], t["to_phc"]["id"], qty, t["priority"],
         t["distance_km"], t["short_reason"], status, username, now_iso()))
    return {"id": t["id"], "status": status, "quantity": qty}
