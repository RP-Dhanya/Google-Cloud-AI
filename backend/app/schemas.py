"""
B. Data validation — request bodies.

Pydantic rejects wrong types and out-of-range values with HTTP 422. The
`before` validators also do light cleaning (trim spaces, accept "1,200" as
1200), so small formatting mistakes from field staff are not rejected.
"""
from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from . import config


def _to_number(v):
    if isinstance(v, str):
        v = v.strip().replace(",", "").replace("_", "")
        if v == "":
            return None
    return v


def _check_report_date(d: dt.date | None) -> dt.date | None:
    if d is None:
        return d
    if d > dt.date.today():
        raise ValueError("date cannot be in the future")
    if d < dt.date.today() - dt.timedelta(days=365):
        raise ValueError("date is more than one year old")
    return d


class Numeric(BaseModel):
    """Base: clean numeric strings on all fields before validation."""
    @field_validator("*", mode="before")
    @classmethod
    def _clean_numbers(cls, v, info):
        if info.field_name in {"phc_id", "name", "district_id", "medicine", "batch", "id", "username", "password", "transfer_id"}:
            return v.strip() if isinstance(v, str) else v
        return _to_number(v)


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1, max_length=128)


# ---------------- Setup: accounts, districts, medicines ----------------
Username = Field(min_length=3, max_length=40, pattern=r"^[a-zA-Z0-9._-]+$")
Password = Field(min_length=8, max_length=128, description="At least 8 characters")


class SetupIn(BaseModel):
    username: str = Username
    password: str = Password
    name: str = Field(min_length=2, max_length=80)


class UserIn(SetupIn):
    role: Literal["admin", "district", "phc"]
    district_id: str | None = None
    phc_id: str | None = None


class DistrictIn(BaseModel):
    id: str = Field(min_length=2, max_length=10, pattern=r"^[A-Za-z0-9-]+$", description="Short code, e.g. CHN")
    name: str = Field(min_length=2, max_length=60)
    state: str = Field(min_length=2, max_length=60)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class MedicineIn(BaseModel):
    id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9-]{2,10}$", description="Optional, e.g. M13")
    name: str = Field(min_length=2, max_length=80)
    unit: str = Field(min_length=1, max_length=20, description="tabs, vials, sachets...")
    category: str | None = Field(default=None, max_length=40)
    min_stock_level: int = Field(default=0, ge=0, le=10_000_000, description="Default minimum stock per PHC")


class StockItemIn(Numeric):
    medicine: str = Field(description="Medicine id (e.g. M01) or name (e.g. 'paracetamol')")
    qty: int = Field(ge=0, le=10_000_000)
    min_qty: int | None = Field(default=None, ge=0, le=10_000_000)
    daily_consumption: float | None = Field(default=None, ge=0, le=1_000_000)
    expiry_date: dt.date | None = None
    batch: str | None = Field(default=None, max_length=40)


class AddPHCIn(Numeric):
    id: str | None = Field(default=None, pattern=r"^[A-Za-z]{3}-\d{2,3}$", description="Optional, e.g. PUN-06")
    name: str = Field(min_length=2, max_length=80)
    district_id: str = Field(min_length=2, max_length=10)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    beds_total: int = Field(ge=0, le=config.MAX_BEDS)
    beds_occupied: int = Field(default=0, ge=0, le=config.MAX_BEDS)
    staff_total: int = Field(ge=1, le=config.MAX_STAFF)
    initial_stock: list[StockItemIn] = Field(default_factory=list)


class UpdateStockIn(StockItemIn):
    phc_id: str
    dispensed_today: int | None = Field(default=None, ge=0, le=10_000_000,
                                        description="Units dispensed today; updates the consumption history")
    date: dt.date | None = None

    @field_validator("date")
    @classmethod
    def _date_ok(cls, v):
        return _check_report_date(v)


class UpdateBedsIn(Numeric):
    phc_id: str
    beds_occupied: int = Field(ge=0, le=config.MAX_BEDS)
    beds_total: int | None = Field(default=None, ge=0, le=config.MAX_BEDS)


class UpdatePatientsIn(Numeric):
    phc_id: str
    patients: int = Field(ge=0, le=config.MAX_DAILY_PATIENTS)
    date: dt.date | None = None

    @field_validator("date")
    @classmethod
    def _date_ok(cls, v):
        return _check_report_date(v)


class UpdateStaffIn(Numeric):
    phc_id: str
    present: int = Field(ge=0, le=config.MAX_STAFF)
    total: int | None = Field(default=None, ge=1, le=config.MAX_STAFF)
    date: dt.date | None = None

    @field_validator("date")
    @classmethod
    def _date_ok(cls, v):
        return _check_report_date(v)


Horizon = Literal[7, 14, 30]


class SimulationIn(Numeric):
    patient_increase: float = Field(default=0, ge=0, le=500, description="% increase in patients")
    medicine_increase: float = Field(default=0, ge=0, le=500, description="% extra medicine per patient")
    staff_reduction: float = Field(default=0, ge=0, le=100, description="% of staff unavailable")
    bed_increase: float = Field(default=0, ge=0, le=500, description="% increase in bed demand")
    horizon: Horizon = 14
    district_id: str | None = None
    include_redistribution: bool = False


class DecisionIn(BaseModel):
    transfer_id: str
    status: Literal["approved", "rejected"]
    horizon: Horizon = 14
    patient_increase: float = Field(default=0, ge=0, le=500)
    medicine_increase: float = Field(default=0, ge=0, le=500)

    @model_validator(mode="after")
    def _id_shape(self):
        if self.transfer_id.count("_") != 2:
            raise ValueError("transfer_id must look like M01_FROM-PHC_TO-PHC")
        return self
