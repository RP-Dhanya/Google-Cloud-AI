"""
Demand forecasting model.

DampedHoltSeasonal = damped Holt linear trend on a de-seasonalised series,
with weekly seasonal indices estimated as ratio-to-moving-average (robust to
trends and outbreak surges). Produces a mean forecast plus an ~80% interval.

To plug in another model (scikit-learn, Prophet, LSTM, a federated model...),
implement the same fit()/predict() interface and register it in MODELS.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import mean, pstdev


@dataclass
class ForecastPoint:
    mean: float
    lo: float
    hi: float
    sd: float


class DampedHoltSeasonal:
    name = "damped-holt-weekly-v1"

    def __init__(self, alpha: float = 0.5, beta: float = 0.2, phi: float = 0.9, period: int = 7):
        self.alpha, self.beta, self.phi, self.period = alpha, beta, phi, period
        self._fitted = False

    def fit(self, series: list[float]) -> "DampedHoltSeasonal":
        s = [max(0.0, float(v)) for v in series]
        self.n = len(s)
        P = self.period
        # Too little history: fall back to a flat mean forecast
        if self.n < 2 * P:
            m = mean(s) if s else 0.0
            self.flat = m
            self.sd = (pstdev(s) if len(s) > 1 else 0.0) or 0.2 * m
            self._fitted = True
            return self
        self.flat = None

        idx, cnt = [0.0] * P, [0] * P
        for i in range(max(3, self.n - 45), self.n - 3):
            ma = mean(s[i - 3:i + 4]) or 1.0
            idx[i % P] += s[i] / ma
            cnt[i % P] += 1
        idx = [idx[p] / cnt[p] if cnt[p] else 1.0 for p in range(P)]
        norm = mean(idx) or 1.0
        self.idx = [v / norm for v in idx]

        des = [v / (self.idx[i % P] or 1.0) for i, v in enumerate(s)]
        level, trend, resid = des[0], 0.0, []
        for i in range(1, self.n):
            pred = level + self.phi * trend
            resid.append(des[i] - pred)
            new_level = self.alpha * des[i] + (1 - self.alpha) * pred
            trend = self.beta * (new_level - level) + (1 - self.beta) * self.phi * trend
            level = new_level
        self.level, self.trend = level, trend
        tail = resid[-28:]
        self.sd = pstdev(tail) if len(tail) > 1 else 0.0
        self._fitted = True
        return self

    def predict(self, h: int) -> list[ForecastPoint]:
        if not self._fitted:
            raise RuntimeError("fit() must be called before predict()")
        out: list[ForecastPoint] = []
        if self.flat is not None:
            for k in range(1, h + 1):
                w = 1.28 * self.sd * math.sqrt(k)
                out.append(ForecastPoint(self.flat, max(0.0, self.flat - w), self.flat + w, w / 1.28))
            return out
        damp = 0.0
        for k in range(1, h + 1):
            damp += self.phi ** k
            s = self.idx[(self.n - 1 + k) % self.period]
            m = max(0.0, (self.level + damp * self.trend) * s)
            w = 1.28 * self.sd * math.sqrt(k) * s
            out.append(ForecastPoint(m, max(0.0, m - w), m + w, w / 1.28))
        return out


MODELS = {DampedHoltSeasonal.name: DampedHoltSeasonal}
DEFAULT_MODEL = DampedHoltSeasonal.name


def get_model(name: str = DEFAULT_MODEL):
    return MODELS[name]()


def backtest_mape(series: list[float], holdout: int = 7) -> float | None:
    """Hide the last `holdout` days, forecast them, return mean absolute % error."""
    if len(series) < holdout + 14:
        return None
    train, test = series[:-holdout], series[-holdout:]
    fc = get_model().fit(train).predict(holdout)
    return 100 * mean(abs(a - f.mean) / max(1.0, a) for a, f in zip(test, fc))


def normal_cdf(z: float) -> float:
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))
