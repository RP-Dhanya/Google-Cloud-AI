"""
PulseGrid backend.

    uvicorn app.main:app --reload        (run from the backend/ folder)

    http://localhost:8000/        -> frontend
    http://localhost:8000/docs    -> interactive API documentation (Swagger)
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import config
from .database import connect, init_schema
from .routers import admin, analytics, auth, data, federated, setup


@asynccontextmanager
async def lifespan(_: FastAPI):
    conn = connect()
    try:
        init_schema(conn)                    # creates empty tables on first run; no demo data is loaded
    finally:
        conn.close()
    yield


app = FastAPI(
    title="PulseGrid API",
    description="Federated PHC resilience platform: health resource and supply chain management for Primary Health Centres.",
    version="1.0.0",
    lifespan=lifespan,
)

# Allow the frontend to call the API when it is served from another port (e.g. VS Code Live Server)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

app.include_router(setup.router)
app.include_router(auth.router)
app.include_router(data.router)
app.include_router(analytics.router)
app.include_router(federated.router)
app.include_router(admin.router)


@app.get("/api/health", tags=["System"])
def health():
    return {"status": "ok", "service": "pulsegrid", "version": app.version}


# Serve the frontend from the same server (must be mounted last)
if config.FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")
