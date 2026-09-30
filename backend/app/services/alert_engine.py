"""
D. Alert engine

Rules checked for every PHC after each data update:

    Stock < minimum level                       -> low-stock alert        (rule: below_minimum)
    Stock = 0                                   -> out-of-stock alert     (rule: out_of_stock)
    Predicted demand (lead time) > stock        -> stock-out warning      (rule: predicted_stockout)
    Bed occupancy >= 85%                        -> bed shortage           (rule: bed_capacity)
    Staff attendance < 80%                      -> staff shortage         (rule: staff_attendance)
    Footfall >= 35% above 4-week baseline       -> emergency warning      (rule: patient_surge)
    Stock expires within 30 days                -> expiry alert           (rule: expiry)

Alerts are stored in the `alerts` table. They stay 'active' while the condition
holds and are marked 'resolved' automatically when it clears.
"""
from __future__ import annotations

import sqlite3

from .. import config
from ..ai.pipeline import run_predictions
from ..database import now_iso
from .network import Network, load_network
from .risk import surge_ratio


def _fmt(n: float) -> str:
    return f"{round(n):,}"


def compute_alerts(net: Network, phc_ids: list[str]) -> dict[str, dict]:
    """Return {alert_id: alert} for all conditions currently true."""
    alerts: dict[str, dict] = {}
    preds = run_predictions(None, net, phc_ids, config.LEAD_TIME_DAYS, log=False)

    def add(aid, type_, rule, severity, phc, title, message, med_id=None):
        alerts[aid] = {"id": aid, "type": type_, "rule": rule, "severity": severity, "phc_id": phc.id,
                       "med_id": med_id, "title": title, "message": message}

    for pid in phc_ids:
        phc = net.phcs.get(pid)
        if not phc:
            continue
        pred = preds[pid]
        for mid, s in phc.stock.items():
            med = net.medicines[mid]
            unit = med["unit"]
            # Rule 1: stock below minimum level (or zero)
            if s.qty <= 0:
                add(f"stock_out:{pid}:{mid}", "stock", "out_of_stock", "critical", phc,
                    f"{med['name']} is out of stock",
                    f"No stock left. Daily consumption is {_fmt(s.daily_consumption)} {unit}.", mid)
            elif s.qty < s.min_qty:
                add(f"stock_min:{pid}:{mid}", "stock", "below_minimum",
                    "critical" if s.qty < s.min_qty * 0.5 else "warning", phc,
                    f"{med['name']} below minimum level",
                    f"{_fmt(s.qty)} {unit} in stock, minimum is {_fmt(s.min_qty)} {unit}.", mid)
            # Rule 2: predicted demand over the resupply lead time exceeds available stock
            mp = pred.meds.get(mid)
            if mp and s.qty > 0 and mp.total > s.qty:
                add(f"stock_forecast:{pid}:{mid}", "stock", "predicted_stockout",
                    "critical" if mp.stockout_day <= 3 else "warning", phc,
                    f"Stock-out warning: {med['name']} runs out in {mp.stockout_day:.1f} days",
                    f"Predicted demand over the next {config.LEAD_TIME_DAYS} days is {_fmt(mp.total)} {unit}, "
                    f"but only {_fmt(s.qty)} {unit} are available (expected stock-out {mp.stockout_date.isoformat()}).", mid)
            # Expiry
            if s.expiry and s.qty > 0:
                days = (s.expiry - net.as_of).days
                if days <= 30:
                    add(f"expiry:{pid}:{mid}", "expiry", "expiry", "critical" if days <= 10 else "warning", phc,
                        f"{med['name']} expired" if days < 0 else f"{med['name']} expiring in {days} days",
                        f"{_fmt(s.qty)} {unit} (batch {s.batch or '-'}) expire on {s.expiry.isoformat()}. "
                        "Consider transferring to a high-demand PHC.", mid)

        if phc.beds_total:
            occ = phc.beds_occupied / phc.beds_total
            if occ >= 0.85:
                add(f"bed:{pid}", "bed", "bed_capacity", "critical" if occ >= 1 else "warning", phc,
                    "All beds occupied" if occ >= 1 else "Bed capacity nearly full",
                    f"{phc.beds_occupied} of {phc.beds_total} beds occupied ({round(occ * 100)}%). Plan referrals.")
        if phc.staff_total:
            att = phc.staff_present / phc.staff_total
            if att < 0.8:
                add(f"staff:{pid}", "staff", "staff_attendance", "critical" if att < 0.7 else "warning", phc,
                    "Staff shortage", f"Only {phc.staff_present} of {phc.staff_total} staff present ({round(att * 100)}%).")
        surge = surge_ratio(phc)
        if surge >= 0.35:
            add(f"emergency:{pid}", "emergency", "patient_surge", "critical", phc,
                "Possible outbreak: patient surge",
                f"Footfall is {round(surge * 100)}% above the 4-week baseline over the last 3 days. Run an emergency simulation.")
    return alerts


def evaluate(conn: sqlite3.Connection, phc_ids: list[str] | None = None) -> dict:
    """Recompute alerts for the given PHCs (default: all) and sync the alerts table."""
    net = load_network(conn, phc_ids)
    ids = list(net.phcs)
    current = compute_alerts(net, ids)
    ts = now_iso()
    created = updated = resolved = 0

    if ids:
        ph = ",".join("?" * len(ids))
        active = {r["id"]: r for r in conn.execute(
            f"SELECT * FROM alerts WHERE status = 'active' AND phc_id IN ({ph})", ids)}
    else:
        active = {}

    for aid, a in current.items():
        if aid in active:
            prev = active[aid]
            # A worsening alert needs to be seen again, so clear the acknowledgement
            reack = prev["severity"] == "warning" and a["severity"] == "critical"
            conn.execute(
                "UPDATE alerts SET severity=?, title=?, message=?, updated_at=?"
                + (", acked_by=NULL, acked_at=NULL" if reack else "") + " WHERE id=?",
                (a["severity"], a["title"], a["message"], ts, aid))
            updated += 1
        else:
            conn.execute(
                "INSERT INTO alerts (id, type, rule, severity, phc_id, med_id, title, message, status, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,'active',?,?) "
                "ON CONFLICT(id) DO UPDATE SET severity=excluded.severity, title=excluded.title, message=excluded.message, "
                "status='active', created_at=excluded.created_at, updated_at=excluded.updated_at, "
                "resolved_at=NULL, acked_by=NULL, acked_at=NULL",
                (aid, a["type"], a["rule"], a["severity"], a["phc_id"], a["med_id"], a["title"], a["message"], ts, ts))
            created += 1
    for aid in set(active) - set(current):
        conn.execute("UPDATE alerts SET status='resolved', resolved_at=?, updated_at=? WHERE id=?", (ts, ts, aid))
        resolved += 1
    return {"active": len(current), "created": created, "updated": updated, "resolved": resolved}
