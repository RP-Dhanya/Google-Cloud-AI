"""Stock status rules and the explainable PHC risk score (same rules as the frontend)."""
from __future__ import annotations

from datetime import date
from statistics import mean

from .network import PHC, Stock


def clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def stock_status(s: Stock, as_of: date) -> dict:
    cover = s.qty / s.daily_consumption if s.daily_consumption > 0 else float("inf")
    days_to_expiry = (s.expiry - as_of).days if s.expiry else None
    base = {"cover_days": cover, "days_to_expiry": days_to_expiry, "out": s.qty <= 0}
    if s.qty <= 0 or cover < 5 or s.qty < s.min_qty * 0.5:
        return {**base, "level": "critical", "label": "Stock-out" if s.qty <= 0 else "Critical"}
    if s.qty < s.min_qty:
        return {**base, "level": "warning", "label": "Warning"}
    return {**base, "level": "normal", "label": "Normal"}


def surge_ratio(phc: PHC) -> float:
    f = phc.footfall
    if len(f) < 10:
        return 0.0
    baseline = mean(f[-31:-3])
    return mean(f[-3:]) / baseline - 1 if baseline else 0.0


def phc_risk(phc: PHC, as_of: date) -> dict:
    out = crit = warn = 0
    for s in phc.stock.values():
        st = stock_status(s, as_of)
        if st["out"]:
            out += 1
        elif st["level"] == "critical":
            crit += 1
        elif st["level"] == "warning":
            warn += 1
    occ = phc.beds_occupied / phc.beds_total if phc.beds_total else 0
    att = phc.staff_present / phc.staff_total if phc.staff_total else 1
    surge = surge_ratio(phc)

    parts = [
        {"key": "Medicine stock", "weight": 40, "v": clamp01((out * 3 + crit * 2 + warn) / 12),
         "text": f"{out} stock-out, {crit} critical, {warn} low medicines"},
        {"key": "Bed occupancy", "weight": 25, "v": clamp01((occ - 0.6) / 0.4), "text": f"{round(occ * 100)}% beds occupied"},
        {"key": "Staff attendance", "weight": 20, "v": clamp01((0.9 - att) / 0.3), "text": f"{round(att * 100)}% staff present"},
        {"key": "Patient surge", "weight": 15, "v": clamp01(surge / 0.5),
         "text": f"{'+' if surge >= 0 else ''}{round(surge * 100)}% footfall vs 4-week baseline"},
    ]
    for p in parts:
        p["points"] = round(p["weight"] * p["v"])
        p["v"] = round(p["v"], 3)
    score = sum(p["points"] for p in parts)
    level = "critical" if score >= 45 else "warning" if score >= 28 else "normal"
    label = {"critical": "High risk", "warning": "Moderate", "normal": "Low risk"}[level]
    return {
        "phc_id": phc.id, "score": score, "level": level, "label": label,
        "parts": parts, "reasons": [p["text"] for p in sorted(parts, key=lambda p: -p["points"]) if p["points"] > 0],
        "stockouts": out, "critical_medicines": crit, "low_medicines": warn,
        "bed_occupancy": round(occ, 3), "staff_attendance": round(att, 3), "surge": round(surge, 3),
    }


def resilience_index(risks: list[dict]) -> int:
    return round(100 - mean(r["score"] for r in risks)) if risks else 100
