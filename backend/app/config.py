"""Central settings. Override any value with an environment variable."""
import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent          # backend/
FRONTEND_DIR = BASE_DIR.parent / "frontend"

DB_PATH = Path(os.getenv("PULSEGRID_DB", BASE_DIR / "pulsegrid.db"))


def _load_secret() -> str:
    """JWT signing key: env var, else a random key persisted to backend/.secret."""
    if os.getenv("PULSEGRID_SECRET"):
        return os.environ["PULSEGRID_SECRET"]
    path = BASE_DIR / ".secret"
    if not path.exists():
        path.write_text(secrets.token_hex(32))
    return path.read_text().strip()


JWT_SECRET = _load_secret()
JWT_ALGORITHM = "HS256"
TOKEN_HOURS = 12

# Business rules (shared with the frontend engine)
HISTORY_DAYS = 60
LEAD_TIME_DAYS = 7          # resupply time; horizon used by the stock-out alert rule
MIN_STOCK_DAYS = 10         # minimum level = 10 days of consumption when not given
PATIENTS_PER_STAFF = 18     # workload norm for the simulator
ROAD_FACTOR = 1.3           # straight-line km -> road km
TRUCK_KMPH = 40

# Data validation limits
MAX_DAILY_PATIENTS = 5000
MAX_BEDS = 500
MAX_STAFF = 500
OUTLIER_FACTOR = 4.0        # value > 4x recent median is flagged
