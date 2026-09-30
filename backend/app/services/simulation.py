"""F. Emergency simulation: feed simulated conditions into the prediction models."""
from __future__ import annotations

import math
import sqlite3

from .. import config
from ..ai.pipeline import Scenario, run_predictions
from .network import Network


def simulate(conn: sqlite3.Connection, net: Network, phc_ids: list[str], scenario: Scenario, horizon: int) -> dict:
    preds = run_predictions(conn, net, phc_ids, horizon, scenario)   # scenario goes through the AI models
    staff_mult = 1 - scenario.staff_reduction / 100
    bed_mult = 1 + scenario.bed_increase / 100

    rows, med_totals = [], {}
    for pid, pred in preds.items():
        phc = pred.phc
        patients = sum(p.mean for p in pred.patients)
        peak = max((p.mean for p in pred.patients), default=0)
        shortages = []
        for mid, m in pred.meds.items():
            deficit = math.ceil(m.total - m.stock.qty)
            if deficit > 0:
                med = net.medicines[mid]
                shortages.append({"med_id": mid, "name": med["name"], "unit": med["unit"],
                                  "stock": m.stock.qty, "demand": round(m.total), "deficit": deficit})
                t = med_totals.setdefault(mid, {"med_id": mid, "name": med["name"], "unit": med["unit"], "deficit": 0, "phcs": 0})
                t["deficit"] += deficit
                t["phcs"] += 1
        beds_needed = math.ceil(phc.beds_occupied * bed_mult)
        bed_deficit = max(0, beds_needed - phc.beds_total)
        staff_avail = math.floor(phc.staff_present * staff_mult)
        staff_needed = math.ceil(peak / config.PATIENTS_PER_STAFF)
        staff_deficit = max(0, staff_needed - staff_avail)

        issues = []
        if shortages:
            issues.append(f"{len(shortages)} medicine shortages")
        if bed_deficit:
            issues.append(f"{bed_deficit} beds short")
        if staff_deficit:
            issues.append(f"{staff_deficit} staff short")
        if len(shortages) >= 5 or bed_deficit > 0 or staff_deficit >= 2:
            level = "critical"
        elif shortages or staff_deficit or beds_needed >= phc.beds_total * 0.9:
            level = "warning"
        else:
            level = "normal"
        rows.append({
            "phc_id": pid, "phc_name": phc.name, "district_id": phc.district_id, "level": level, "issues": issues,
            "predicted_patients": round(patients), "peak_daily_patients": round(peak),
            "beds_needed": beds_needed, "beds_total": phc.beds_total, "bed_deficit": bed_deficit,
            "staff_available": staff_avail, "staff_needed": staff_needed, "staff_deficit": staff_deficit,
            "shortages": sorted(shortages, key=lambda s: -s["deficit"] / max(1, s["demand"])),
        })

    order = {"critical": 0, "warning": 1, "normal": 2}
    rows.sort(key=lambda r: (order[r["level"]], -len(r["shortages"])))
    return {
        "scenario": {**scenario.__dict__, "horizon": horizon},
        "assumption": "No resupply arrives during the horizon.",
        "summary": {
            "phcs": len(rows),
            "critical": sum(r["level"] == "critical" for r in rows),
            "warning": sum(r["level"] == "warning" for r in rows),
            "shortage_lines": sum(len(r["shortages"]) for r in rows),
            "required_beds": sum(r["bed_deficit"] for r in rows),
            "required_staff": sum(r["staff_deficit"] for r in rows),
        },
        "critical_phcs": [r for r in rows if r["level"] == "critical"],
        "required_medicines": sorted(med_totals.values(), key=lambda t: (-t["phcs"], -t["deficit"])),
        "phcs": rows,
    }
