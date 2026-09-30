"""Admin utilities."""
import sqlite3

from fastapi import APIRouter, Depends

from ..database import get_db
from ..security import require_roles
from ..services import alert_engine

router = APIRouter(prefix="/api/admin", tags=["Admin"], dependencies=[Depends(require_roles("admin"))])


@router.post("/run_alert_engine", summary="Re-run the alert engine over every PHC")
def run_alert_engine(conn: sqlite3.Connection = Depends(get_db)):
    return alert_engine.evaluate(conn)
