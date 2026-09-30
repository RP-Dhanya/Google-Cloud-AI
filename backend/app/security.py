"""C. Authentication: password hashing, JWT tokens, roles and access permissions."""
import hashlib
import hmac
import os
import sqlite3
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from . import config
from .database import get_db

PBKDF2_ITERATIONS = 200_000
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/login/form")


# ---------- Passwords ----------
def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iterations, salt_hex, digest_hex = stored.split("$")
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(iterations))
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


# ---------- Tokens ----------
def create_token(user: sqlite3.Row) -> str:
    payload = {
        "sub": user["username"],
        "role": user["role"],
        "exp": datetime.now(timezone.utc) + timedelta(hours=config.TOKEN_HOURS),
    }
    return jwt.encode(payload, config.JWT_SECRET, algorithm=config.JWT_ALGORITHM)


def authenticate(conn: sqlite3.Connection, username: str, password: str) -> sqlite3.Row | None:
    user = conn.execute(
        "SELECT * FROM users WHERE username = ? AND active = 1", (username.strip().lower(),)
    ).fetchone()
    if user and verify_password(password, user["password_hash"]):
        return user
    return None


def public_user(user: sqlite3.Row) -> dict:
    return {k: user[k] for k in ("username", "role", "name", "district_id", "phc_id")}


# ---------- Dependencies ----------
def current_user(token: str = Depends(oauth2_scheme), conn: sqlite3.Connection = Depends(get_db)) -> dict:
    unauthorized = HTTPException(
        status.HTTP_401_UNAUTHORIZED, "Invalid or expired token", headers={"WWW-Authenticate": "Bearer"}
    )
    try:
        payload = jwt.decode(token, config.JWT_SECRET, algorithms=[config.JWT_ALGORITHM])
    except jwt.PyJWTError:
        raise unauthorized
    user = conn.execute("SELECT * FROM users WHERE username = ? AND active = 1", (payload.get("sub"),)).fetchone()
    if not user:
        raise unauthorized
    return public_user(user)


def require_roles(*roles: str):
    """Dependency factory: only the given roles may call the endpoint."""
    def checker(user: dict = Depends(current_user)) -> dict:
        if user["role"] not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Requires role: {', '.join(roles)}")
        return user
    return checker


# ---------- Data scoping ----------
def scope_phc_ids(conn: sqlite3.Connection, user: dict) -> list[str]:
    """PHC ids the user may see: admin = all, district officer = own district, PHC = own PHC."""
    if user["role"] == "admin":
        rows = conn.execute("SELECT id FROM phcs ORDER BY id").fetchall()
    elif user["role"] == "district":
        rows = conn.execute("SELECT id FROM phcs WHERE district_id = ? ORDER BY id", (user["district_id"],)).fetchall()
    else:
        rows = conn.execute("SELECT id FROM phcs WHERE id = ?", (user["phc_id"],)).fetchall()
    return [r["id"] for r in rows]


def ensure_phc_access(conn: sqlite3.Connection, user: dict, phc_id: str) -> sqlite3.Row:
    """404 if the PHC does not exist, 403 if it is outside the user's scope."""
    phc = conn.execute("SELECT * FROM phcs WHERE id = ?", (phc_id,)).fetchone()
    if not phc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"PHC '{phc_id}' not found")
    if user["role"] == "district" and phc["district_id"] != user["district_id"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This PHC is outside your district")
    if user["role"] == "phc" and phc["id"] != user["phc_id"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only access your own PHC")
    return phc


def ensure_district_access(user: dict, district_id: str) -> None:
    if user["role"] == "district" and district_id != user["district_id"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This district is outside your scope")
    if user["role"] == "phc":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "PHC staff cannot access district data")
