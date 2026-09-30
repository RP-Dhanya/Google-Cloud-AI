"""
B. Data processing: clean incorrect values and keep an audit trail.

Validation (schemas.py) rejects impossible input. The Cleaner here handles
input that is wrong but fixable, or suspicious. Every correction and flag is
returned to the caller and written to data_quality_log.
"""
from __future__ import annotations

import difflib
import re
import sqlite3
from statistics import median

from fastapi import HTTPException

from . import config
from .database import now_iso


class Cleaner:
    def __init__(self, conn: sqlite3.Connection, endpoint: str, user: dict, phc_id: str | None = None):
        self.conn, self.endpoint, self.user, self.phc_id = conn, endpoint, user, phc_id
        self.notes: list[dict] = []

    def corrected(self, field: str, original, cleaned, note: str):
        self.notes.append({"field": field, "action": "corrected", "original": original, "cleaned": cleaned, "note": note})
        return cleaned

    def flagged(self, field: str, value, note: str):
        self.notes.append({"field": field, "action": "flagged", "original": value, "cleaned": value, "note": note})
        return value

    def save(self) -> list[dict]:
        ts = now_iso()
        self.conn.executemany(
            "INSERT INTO data_quality_log (endpoint, phc_id, field, original, cleaned, action, note, username, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            [(self.endpoint, self.phc_id, n["field"], str(n["original"]), str(n["cleaned"]), n["action"], n["note"],
              self.user["username"], ts) for n in self.notes])
        return self.notes

    # ---------- specific cleaning rules ----------
    def phc_name(self, name: str) -> str:
        clean = re.sub(r"\s+", " ", name).strip()
        clean = re.sub(r"^(phc|p\.h\.c\.?)\s*", "", clean, flags=re.I)
        clean = "PHC " + " ".join(w if w.isupper() and len(w) > 1 else w.capitalize() for w in clean.split())
        if clean != name:
            self.corrected("name", name, clean, "Normalised PHC name")
        return clean

    def resolve_medicine(self, value: str) -> sqlite3.Row:
        meds = self.conn.execute("SELECT * FROM medicines").fetchall()
        v = value.strip()
        for m in meds:
            if m["id"].lower() == v.lower() or m["name"].lower() == v.lower():
                return m
        # Prefix match ("paracetamol" -> "Paracetamol 500mg"), then fuzzy match for typos
        prefix = [m for m in meds if m["name"].lower().startswith(v.lower())]
        match = prefix[0] if len(prefix) == 1 else None
        if not match:
            names = {m["name"].lower(): m for m in meds}
            close = difflib.get_close_matches(v.lower(), names.keys(), n=1, cutoff=0.75)
            match = names[close[0]] if close else None
        if not match:
            raise HTTPException(422, f"Unknown medicine '{value}'. Use an id (M01–M{len(meds):02d}) or a catalogue name.")
        self.corrected("medicine", value, match["name"], "Matched to catalogue medicine")
        return match

    def clamp(self, field: str, value: int, maximum: int, note: str) -> int:
        if value > maximum:
            return self.corrected(field, value, maximum, note)
        return value

    def outlier(self, field: str, value: float, history: list[float]):
        recent = [h for h in history[-28:] if h is not None]
        if len(recent) >= 7:
            med = median(recent)
            if med > 0 and value > config.OUTLIER_FACTOR * med:
                self.flagged(field, value, f"{value} is more than {config.OUTLIER_FACTOR:g}x the recent median ({med:g}). "
                                           "Stored as reported; please verify (data-entry error or genuine surge?).")
