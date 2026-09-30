"""Load the PHC network from SQL into plain Python objects for the analytics layer."""
from __future__ import annotations

import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta

from .. import config


@dataclass
class Stock:
    phc_id: str
    med_id: str
    qty: int
    min_qty: int
    daily_consumption: float
    expiry: date | None
    batch: str | None
    consumption: list[int] = field(default_factory=list)


@dataclass
class PHC:
    id: str
    name: str
    district_id: str
    lat: float
    lon: float
    beds_total: int
    beds_occupied: int
    staff_total: int
    staff_present: int
    footfall: list[int]
    staff_history: list[int]
    stock: dict[str, Stock]


@dataclass
class Network:
    as_of: date
    dates: list[date]
    districts: dict[str, dict]
    medicines: dict[str, dict]
    phcs: dict[str, PHC]

    def in_district(self, district_id: str) -> list[PHC]:
        return [p for p in self.phcs.values() if p.district_id == district_id]


def _align(points: dict[str, int], dates: list[date], default: int = 0) -> list[int]:
    """Place values on the date axis: forward-fill gaps, back-fill the start."""
    out: list[int | None] = []
    last = None
    for d in dates:
        v = points.get(d.isoformat())
        if v is not None:
            last = v
        out.append(last)
    first = next((v for v in out if v is not None), default)
    return [first if v is None else v for v in out]


def latest_date(conn: sqlite3.Connection) -> date:
    row = conn.execute("SELECT MAX(date) AS d FROM footfall_daily").fetchone()
    return date.fromisoformat(row["d"]) if row and row["d"] else date.today()


def load_network(conn: sqlite3.Connection, phc_ids: list[str] | None = None,
                 history_days: int = config.HISTORY_DAYS) -> Network:
    as_of = latest_date(conn)
    dates = [as_of - timedelta(days=history_days - 1 - i) for i in range(history_days)]
    start = dates[0].isoformat()

    where, params = "", []
    if phc_ids is not None:
        if not phc_ids:
            return Network(as_of, dates, {}, {}, {})
        where = f" WHERE id IN ({','.join('?' * len(phc_ids))})"
        params = list(phc_ids)
    phc_rows = conn.execute(f"SELECT * FROM phcs{where} ORDER BY id", params).fetchall()
    ids = [r["id"] for r in phc_rows]
    if not ids:
        return Network(as_of, dates, _districts(conn), _medicines(conn), {})
    ph = ",".join("?" * len(ids))

    foot, staff, cons = defaultdict(dict), defaultdict(dict), defaultdict(dict)
    for r in conn.execute(f"SELECT phc_id, date, patients FROM footfall_daily WHERE date >= ? AND phc_id IN ({ph})", [start, *ids]):
        foot[r["phc_id"]][r["date"]] = r["patients"]
    for r in conn.execute(f"SELECT phc_id, date, present FROM staff_daily WHERE date >= ? AND phc_id IN ({ph})", [start, *ids]):
        staff[r["phc_id"]][r["date"]] = r["present"]
    for r in conn.execute(f"SELECT phc_id, med_id, date, units FROM consumption_daily WHERE date >= ? AND phc_id IN ({ph})", [start, *ids]):
        cons[(r["phc_id"], r["med_id"])][r["date"]] = r["units"]

    stock = defaultdict(dict)
    for r in conn.execute(f"SELECT * FROM stock WHERE phc_id IN ({ph})", ids):
        stock[r["phc_id"]][r["med_id"]] = Stock(
            phc_id=r["phc_id"], med_id=r["med_id"], qty=r["qty"], min_qty=r["min_qty"],
            daily_consumption=r["daily_consumption"],
            expiry=date.fromisoformat(r["expiry_date"]) if r["expiry_date"] else None,
            batch=r["batch"],
            consumption=_align(cons.get((r["phc_id"], r["med_id"]), {}), dates),
        )

    phcs = {}
    for r in phc_rows:
        staff_hist = _align(staff.get(r["id"], {}), dates, default=r["staff_total"])
        phcs[r["id"]] = PHC(
            id=r["id"], name=r["name"], district_id=r["district_id"], lat=r["lat"], lon=r["lon"],
            beds_total=r["beds_total"], beds_occupied=r["beds_occupied"], staff_total=r["staff_total"],
            staff_present=staff_hist[-1], footfall=_align(foot.get(r["id"], {}), dates),
            staff_history=staff_hist, stock=stock.get(r["id"], {}),
        )
    return Network(as_of, dates, _districts(conn), _medicines(conn), phcs)


def _districts(conn):
    return {r["id"]: dict(r) for r in conn.execute("SELECT * FROM districts ORDER BY id")}


def _medicines(conn):
    return {r["id"]: dict(r) for r in conn.execute("SELECT * FROM medicines ORDER BY id")}
