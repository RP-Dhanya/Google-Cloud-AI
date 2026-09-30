"""C. Authentication endpoints."""
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm

from ..database import get_db
from ..schemas import LoginIn
from ..security import authenticate, create_token, current_user, public_user

router = APIRouter(prefix="/api", tags=["Authentication"])


def _login(conn, username, password):
    user = authenticate(conn, username, password)
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid username or password")
    return {"access_token": create_token(user), "token_type": "bearer", "user": public_user(user)}


@router.post("/login", summary="Log in with username + password (JSON)")
def login(body: LoginIn, conn: sqlite3.Connection = Depends(get_db)):
    return _login(conn, body.username, body.password)


@router.post("/login/form", summary="Log in (OAuth2 form, used by the Swagger 'Authorize' button)")
def login_form(form: OAuth2PasswordRequestForm = Depends(), conn: sqlite3.Connection = Depends(get_db)):
    return _login(conn, form.username, form.password)


@router.get("/me", summary="Current user and role")
def me(user: dict = Depends(current_user)):
    return user
