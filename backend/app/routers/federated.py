"""Federated learning API: cross-district collaborative model training without sharing raw data."""
import json
import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from ..database import get_db, now_iso
from ..security import current_user, require_roles

router = APIRouter(prefix="/api/federated", tags=["Federated"])


@router.get("/status", summary="Federated learning runs and convergence")
def federated_status(user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    """Return historical training runs and current model performance by district."""
    runs = conn.execute(
        "SELECT id, config, result, created_at FROM federated_runs ORDER BY created_at DESC LIMIT 5"
    ).fetchall()
    return {
        "runs": [{"id": r["id"], "created_at": r["created_at"], **json.loads(r["result"])}
                 for r in runs],
        "message": "Districts train local models on their own data. The server aggregates updates without seeing raw data."
    }


@router.post("/train", summary="Start a new federated training round",
             dependencies=[Depends(require_roles("admin"))])
def federated_train(conn: sqlite3.Connection = Depends(get_db)):
    """
    Initiate a federated learning round:
    1. Each district trains on its own footfall/patient data
    2. Sends model weights to the server (not raw data)
    3. Server averages the updates
    4. Global model sent back to all districts
    """
    districts = conn.execute("SELECT COUNT(DISTINCT district_id) FROM phcs").fetchone()[0]
    if districts < 2:
        raise HTTPException(400, "Need at least 2 districts to run federation")

    # Stub: in production, this would orchestrate federated training
    # For now, return a demo result showing convergence
    config = {"local_epochs": 2, "lr": 0.01, "secure_aggregation": True, "dp_noise": 0}
    result = {
        "round": 1,
        "districts": districts,
        "rows_per_district": conn.execute(
            "SELECT district_id, COUNT(*) FROM footfall_daily GROUP BY district_id"
        ).fetchall(),
        "message": "Federated training requires real data. Set up districts and enter daily reports first.",
    }

    conn.execute(
        "INSERT INTO federated_runs (config, result, created_by, created_at) VALUES (?,?,?,?)",
        (json.dumps(config), json.dumps(result), "system", now_iso())
    )
    return result
