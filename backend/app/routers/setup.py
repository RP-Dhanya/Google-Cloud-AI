"""
Setup endpoints: everything the system knows is entered by its users.

  First run      : POST /api/setup creates the administrator (only while no users exist)
  Admin          : districts, medicine catalogue, user accounts
  District officer: user accounts for PHCs in their own district
"""
import re
import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from ..database import get_db
from ..schemas import DistrictIn, MedicineIn, SetupIn, UserIn
from ..security import create_token, current_user, hash_password, public_user, require_roles

router = APIRouter(prefix="/api", tags=["Setup"])


def _user_count(conn) -> int:
    return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]


@router.get("/setup/status", summary="Is first-run setup needed? (public)")
def setup_status(conn: sqlite3.Connection = Depends(get_db)):
    counts = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("users", "districts", "phcs", "medicines")}
    return {"needs_setup": counts["users"] == 0, "counts": counts}


@router.post("/setup", summary="Create the first administrator (only works on an empty system)")
def setup(body: SetupIn, conn: sqlite3.Connection = Depends(get_db)):
    if _user_count(conn):
        raise HTTPException(409, "Setup has already been completed")
    conn.execute("INSERT INTO users (username, password_hash, role, name) VALUES (?,?,?,?)",
                 (body.username.lower(), hash_password(body.password), "admin", body.name.strip()))
    user = conn.execute("SELECT * FROM users WHERE username=?", (body.username.lower(),)).fetchone()
    return {"access_token": create_token(user), "token_type": "bearer", "user": public_user(user)}


# ---------------- Districts ----------------
@router.get("/districts", summary="List districts")
def list_districts(user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    rows = conn.execute("SELECT d.*, (SELECT COUNT(*) FROM phcs p WHERE p.district_id=d.id) AS phc_count "
                        "FROM districts d ORDER BY d.name").fetchall()
    return [dict(r) for r in rows]


@router.post("/districts", summary="Add a district", dependencies=[Depends(require_roles("admin"))])
def add_district(body: DistrictIn, conn: sqlite3.Connection = Depends(get_db)):
    did = body.id.upper()
    if conn.execute("SELECT 1 FROM districts WHERE id=?", (did,)).fetchone():
        raise HTTPException(409, f"District {did} already exists")
    conn.execute("INSERT INTO districts (id, name, state, lat, lon) VALUES (?,?,?,?,?)",
                 (did, body.name.strip().title(), body.state.strip().title(), body.lat, body.lon))
    return {"status": "ok", "id": did}


# ---------------- Medicine catalogue ----------------
@router.get("/medicines", summary="Medicine catalogue")
def list_medicines(user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    return [dict(r) for r in conn.execute("SELECT * FROM medicines ORDER BY name")]


@router.post("/medicines", summary="Add a medicine to the catalogue", dependencies=[Depends(require_roles("admin"))])
def add_medicine(body: MedicineIn, conn: sqlite3.Connection = Depends(get_db)):
    name = re.sub(r"\s+", " ", body.name).strip()
    if conn.execute("SELECT 1 FROM medicines WHERE lower(name)=lower(?)", (name,)).fetchone():
        raise HTTPException(409, f"{name} is already in the catalogue")
    if body.id:
        mid = body.id.upper()
        if conn.execute("SELECT 1 FROM medicines WHERE id=?", (mid,)).fetchone():
            raise HTTPException(409, f"Medicine id {mid} already exists")
    else:
        nums = [int(r["id"][1:]) for r in conn.execute("SELECT id FROM medicines") if re.fullmatch(r"M\d+", r["id"])]
        mid = f"M{(max(nums) + 1 if nums else 1):02d}"
    conn.execute("INSERT INTO medicines (id, name, unit, category, min_stock_level) VALUES (?,?,?,?,?)",
                 (mid, name, body.unit.strip().lower(), body.category, body.min_stock_level))
    return {"status": "ok", "id": mid, "name": name}


# ---------------- Users ----------------
@router.get("/users", summary="User accounts (admin: all, district officer: own district)",
            dependencies=[Depends(require_roles("admin", "district"))])
def list_users(user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    sql, params = "SELECT username, role, name, district_id, phc_id, active FROM users", []
    if user["role"] == "district":
        sql += " WHERE district_id = ?"
        params.append(user["district_id"])
    return [dict(r) for r in conn.execute(sql + " ORDER BY role, username", params)]


@router.post("/users", summary="Create a user account", dependencies=[Depends(require_roles("admin", "district"))])
def add_user(body: UserIn, user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    district_id, phc_id = body.district_id, body.phc_id
    if user["role"] == "district" and body.role != "phc":
        raise HTTPException(403, "District officers can only create PHC staff accounts")
    if body.role == "district":
        if not district_id or not conn.execute("SELECT 1 FROM districts WHERE id=?", (district_id.upper(),)).fetchone():
            raise HTTPException(422, "A valid district_id is required for a district officer")
        district_id, phc_id = district_id.upper(), None
    elif body.role == "phc":
        phc = conn.execute("SELECT * FROM phcs WHERE id=?", ((phc_id or "").upper(),)).fetchone()
        if not phc:
            raise HTTPException(422, "A valid phc_id is required for PHC staff")
        if user["role"] == "district" and phc["district_id"] != user["district_id"]:
            raise HTTPException(403, "That PHC is outside your district")
        district_id, phc_id = phc["district_id"], phc["id"]
    else:
        district_id = phc_id = None
    if conn.execute("SELECT 1 FROM users WHERE username=?", (body.username.lower(),)).fetchone():
        raise HTTPException(409, f"Username {body.username} is taken")
    conn.execute("INSERT INTO users (username, password_hash, role, name, district_id, phc_id) VALUES (?,?,?,?,?,?)",
                 (body.username.lower(), hash_password(body.password), body.role, body.name.strip(), district_id, phc_id))
    return {"status": "ok", "username": body.username.lower(), "role": body.role}


@router.post("/users/{username}/deactivate", summary="Disable a user account", dependencies=[Depends(require_roles("admin"))])
def deactivate_user(username: str, user: dict = Depends(current_user), conn: sqlite3.Connection = Depends(get_db)):
    if username == user["username"]:
        raise HTTPException(400, "You cannot deactivate your own account")
    if not conn.execute("UPDATE users SET active=0 WHERE username=?", (username,)).rowcount:
        raise HTTPException(404, "User not found")
    return {"status": "ok"}
