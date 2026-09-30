"""
E. AI integration pipeline

    Database  ->  load_network()  ->  model.fit/predict  ->  predictions  ->  API  ->  frontend

predict_phc() turns a PHC's footfall history into patient and medicine demand
forecasts, stock-out dates and stock-out risk. It also accepts scenario
multipliers so the emergency simulator can reuse the same models.
"""
from __future__ import annotations

import json
import math
import sqlite3
from dataclasses import dataclass
from datetime import date, timedelta
from statistics import mean

from .. import config
from ..database import now_iso
from ..services.network import PHC, Network, Stock
from .forecasting import DEFAULT_MODEL, ForecastPoint, backtest_mape, get_model, normal_cdf


@dataclass
class Scenario:
    patient_increase: float = 0      # %
    medicine_increase: float = 0     # % extra per patient
    staff_reduction: float = 0       # %
    bed_increase: float = 0          # %

    @property
    def patient_mult(self) -> float:
        return 1 + self.patient_increase / 100

    @property
    def medicine_mult(self) -> float:
        return self.patient_mult * (1 + self.medicine_increase / 100)

    def is_baseline(self) -> bool:
        return not any((self.patient_increase, self.medicine_increase, self.staff_reduction, self.bed_increase))


@dataclass
class MedPrediction:
    stock: Stock
    daily: list[float]
    total: float
    stockout_day: float
    stockout_date: date
    risk: int
    shortfall: float


@dataclass
class PHCPrediction:
    phc: PHC
    horizon: int
    patients: list[ForecastPoint]
    meds: dict[str, MedPrediction]
    mape: float | None
    model: str


def predict_phc(net: Network, phc: PHC, horizon: int, scenario: Scenario | None = None) -> PHCPrediction:
    sc = scenario or Scenario()
    model = get_model()
    base = model.fit(phc.footfall).predict(horizon)
    pm = sc.patient_mult
    patients = [ForecastPoint(p.mean * pm, p.lo * pm, p.hi * pm, p.sd * pm) for p in base]
    recent = mean(phc.footfall[-7:]) if phc.footfall else 0

    meds = {}
    for med_id, s in phc.stock.items():
        # Units per patient observed at this PHC; if no patients recorded, use the raw daily consumption
        per_patient = s.daily_consumption / recent if recent > 0 else 0
        mult = sc.medicine_mult
        if per_patient:
            # medicine_mult already includes the patient increase, so start from the unscaled forecast
            daily = [p.mean * per_patient * mult for p in base]
            sds = [p.sd * per_patient * mult for p in base]
        else:
            daily = [s.daily_consumption * mult] * horizon
            sds = [0.1 * s.daily_consumption * mult] * horizon
        total = sum(daily)

        if s.qty <= 0:
            day = 0.0
        else:
            cum, day = 0.0, None
            for k, d in enumerate(daily):
                cum += d
                if cum >= s.qty:
                    day = k + (1 - (cum - s.qty) / d if d else 0)
                    break
            if day is None:
                last = daily[-1] if daily and daily[-1] > 0 else 0
                day = horizon + (s.qty - cum) / last if last else 9999.0
        sd_total = math.sqrt(sum(x * x for x in sds) + (0.1 * total) ** 2)
        risk = 100 if s.qty <= 0 else round(100 * (1 - normal_cdf((s.qty - total) / max(1.0, sd_total))))
        meds[med_id] = MedPrediction(
            stock=s, daily=daily, total=total, stockout_day=day,
            stockout_date=net.as_of + timedelta(days=int(min(day, 3650))),
            risk=risk, shortfall=max(0.0, total - s.qty),
        )
    return PHCPrediction(phc, horizon, patients, meds, backtest_mape(phc.footfall), DEFAULT_MODEL)


def run_predictions(conn: sqlite3.Connection | None, net: Network, phc_ids: list[str], horizon: int,
                    scenario: Scenario | None = None, log: bool = True) -> dict[str, PHCPrediction]:
    """Run the model for many PHCs and record each run in prediction_runs."""
    results = {pid: predict_phc(net, net.phcs[pid], horizon, scenario) for pid in phc_ids if pid in net.phcs}
    if conn is not None and log and results:
        ts = now_iso()
        sc_json = json.dumps(scenario.__dict__) if scenario and not scenario.is_baseline() else None
        conn.executemany(
            "INSERT INTO prediction_runs (phc_id, horizon, model, mape, scenario, generated_at) VALUES (?,?,?,?,?,?)",
            [(pid, horizon, r.model, r.mape, sc_json, ts) for pid, r in results.items()],
        )
    return results


def serialize(pred: PHCPrediction, net: Network, include_daily: bool = True) -> dict:
    """Shape a prediction for the API response."""
    phc = pred.phc
    return {
        "phc_id": phc.id,
        "phc_name": phc.name,
        "district_id": phc.district_id,
        "horizon": pred.horizon,
        "model": pred.model,
        "backtest_mape": None if pred.mape is None else round(pred.mape, 2),
        "as_of": net.as_of.isoformat(),
        "patients": {
            "total": round(sum(p.mean for p in pred.patients)),
            "daily": [
                {"date": (net.as_of + timedelta(days=k + 1)).isoformat(),
                 "mean": round(p.mean, 1), "lo": round(p.lo, 1), "hi": round(p.hi, 1), "sd": round(p.sd, 2)}
                for k, p in enumerate(pred.patients)
            ],
        },
        "medicines": sorted([
            {
                "med_id": mid,
                "name": net.medicines[mid]["name"],
                "unit": net.medicines[mid]["unit"],
                "current_stock": m.stock.qty,
                "min_qty": m.stock.min_qty,
                "predicted_demand": round(m.total),
                "avg_daily_demand": round(m.total / pred.horizon, 1),
                **({"daily_demand": [round(d, 1) for d in m.daily]} if include_daily else {}),
                "stockout_in_days": None if m.stockout_day >= 9999 else round(m.stockout_day, 1),
                "expected_stockout_date": None if m.stockout_day >= 9999 else m.stockout_date.isoformat(),
                "stockout_within_horizon": m.stockout_day <= pred.horizon,
                "risk_percent": m.risk,
                "shortfall": round(m.shortfall),
            }
            for mid, m in pred.meds.items()
        ], key=lambda x: (x["stockout_in_days"] is None, x["stockout_in_days"] or 0)),
    }
