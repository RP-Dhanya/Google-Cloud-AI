-- =========================================================================
-- PulseGrid database schema (SQLite; portable to PostgreSQL/MySQL)
-- =========================================================================
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS districts (
    id      TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    state   TEXT NOT NULL,
    lat     REAL NOT NULL,
    lon     REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS phcs (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    district_id    TEXT NOT NULL REFERENCES districts(id),
    lat            REAL NOT NULL,
    lon            REAL NOT NULL,
    beds_total     INTEGER NOT NULL CHECK (beds_total >= 0),
    beds_occupied  INTEGER NOT NULL DEFAULT 0 CHECK (beds_occupied >= 0),
    staff_total    INTEGER NOT NULL CHECK (staff_total >= 0),
    population_served INTEGER CHECK (population_served >= 0),
    created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS medicines (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL UNIQUE,
    unit      TEXT NOT NULL,
    category  TEXT,
    min_stock_level INTEGER NOT NULL DEFAULT 0 CHECK (min_stock_level >= 0),  -- default minimum per PHC
    rate      REAL NOT NULL DEFAULT 0      -- typical units per patient visit
);

-- Current stock of each medicine at each PHC
CREATE TABLE IF NOT EXISTS stock (
    phc_id             TEXT NOT NULL REFERENCES phcs(id) ON DELETE CASCADE,
    med_id             TEXT NOT NULL REFERENCES medicines(id),
    qty                INTEGER NOT NULL CHECK (qty >= 0),
    min_qty            INTEGER NOT NULL CHECK (min_qty >= 0),
    daily_consumption  REAL NOT NULL DEFAULT 0 CHECK (daily_consumption >= 0),
    expiry_date        TEXT,
    batch              TEXT,
    updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (phc_id, med_id)
);

-- Daily time series (inputs for the AI models)
CREATE TABLE IF NOT EXISTS footfall_daily (
    phc_id    TEXT NOT NULL REFERENCES phcs(id) ON DELETE CASCADE,
    date      TEXT NOT NULL,
    patients  INTEGER NOT NULL CHECK (patients >= 0),
    emergency_cases INTEGER NOT NULL DEFAULT 0 CHECK (emergency_cases >= 0),
    is_holiday INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (phc_id, date)
);

-- Patients by disease category (fever, respiratory, diarrhoeal, ...)
CREATE TABLE IF NOT EXISTS patient_diseases (
    phc_id    TEXT NOT NULL REFERENCES phcs(id) ON DELETE CASCADE,
    date      TEXT NOT NULL,
    category  TEXT NOT NULL,
    cases     INTEGER NOT NULL CHECK (cases >= 0),
    PRIMARY KEY (phc_id, date, category)
);

CREATE TABLE IF NOT EXISTS staff_daily (
    phc_id   TEXT NOT NULL REFERENCES phcs(id) ON DELETE CASCADE,
    date     TEXT NOT NULL,
    present  INTEGER NOT NULL CHECK (present >= 0),
    total    INTEGER NOT NULL CHECK (total >= 0),
    PRIMARY KEY (phc_id, date)
);

CREATE TABLE IF NOT EXISTS consumption_daily (
    phc_id  TEXT NOT NULL REFERENCES phcs(id) ON DELETE CASCADE,
    med_id  TEXT NOT NULL REFERENCES medicines(id),
    date    TEXT NOT NULL,
    units   INTEGER NOT NULL CHECK (units >= 0),
    PRIMARY KEY (phc_id, med_id, date)
);

-- Users and roles
CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('admin', 'district', 'phc')),
    name           TEXT NOT NULL,
    district_id    TEXT REFERENCES districts(id),
    phc_id         TEXT REFERENCES phcs(id),
    active         INTEGER NOT NULL DEFAULT 1
);

-- Alerts written by the alert engine (active until the condition clears)
CREATE TABLE IF NOT EXISTS alerts (
    id           TEXT PRIMARY KEY,           -- e.g. stock_min:PAT-01:M03
    type         TEXT NOT NULL,              -- stock | bed | staff | emergency | expiry
    rule         TEXT NOT NULL,              -- which rule fired
    severity     TEXT NOT NULL CHECK (severity IN ('critical', 'warning')),
    phc_id       TEXT NOT NULL REFERENCES phcs(id) ON DELETE CASCADE,
    med_id       TEXT REFERENCES medicines(id),
    title        TEXT NOT NULL,
    message      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    resolved_at  TEXT,
    acked_by     TEXT,
    acked_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status, phc_id);

-- Redistribution decisions
CREATE TABLE IF NOT EXISTS transfers (
    id          TEXT PRIMARY KEY,
    med_id      TEXT NOT NULL REFERENCES medicines(id),
    from_phc    TEXT NOT NULL REFERENCES phcs(id),
    to_phc      TEXT NOT NULL REFERENCES phcs(id),
    qty         INTEGER NOT NULL CHECK (qty > 0),
    priority    TEXT NOT NULL,
    km          REAL,
    reason      TEXT,
    status      TEXT NOT NULL CHECK (status IN ('approved', 'rejected')),
    decided_by  TEXT NOT NULL,
    decided_at  TEXT NOT NULL
);

-- Every prediction run (traceability of the AI layer)
CREATE TABLE IF NOT EXISTS prediction_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    phc_id        TEXT NOT NULL,
    horizon       INTEGER NOT NULL,
    model         TEXT NOT NULL,
    mape          REAL,
    scenario      TEXT,                      -- JSON of simulation inputs, if any
    generated_at  TEXT NOT NULL
);

-- What the cleaning step changed or flagged
CREATE TABLE IF NOT EXISTS data_quality_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint    TEXT NOT NULL,
    phc_id      TEXT,
    field       TEXT NOT NULL,
    original    TEXT,
    cleaned     TEXT,
    action      TEXT NOT NULL,               -- corrected | flagged
    note        TEXT,
    username    TEXT,
    created_at  TEXT NOT NULL
);

-- Federated learning runs (one row per training run; rounds and metrics stored as JSON)
CREATE TABLE IF NOT EXISTS federated_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    config      TEXT NOT NULL,
    result      TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
