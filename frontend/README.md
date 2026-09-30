# PulseGrid — Federated PHC Resilience Platform (Frontend)

Track 3 · Smart Health & Supply Chain Resilience (BRICS theme: Resilience)

## Run it

No build step and no internet connection needed. Open `index.html` in Chrome or Edge.
You can also serve the folder with any static server, for example `npx serve .`.

| Role | Username | Password | Lands on |
|---|---|---|---|
| Admin (national) | `admin` | `admin123` | National Overview |
| District Health Officer | `dho.patna` / `dho.pune` | `dho123` | District Overview |
| PHC staff | `phc.danapur` / `phc.aluva` | `phc123` | PHC Dashboard |

## Pages

| File | Requirement | Roles |
|---|---|---|
| `index.html` | A. Login & role selection | all |
| `dashboard.html` | B. National/District dashboard, Resilience Index, map | admin, district |
| `phc.html` | C. PHC dashboard with explainable risk score | all (scoped) |
| `medicines.html` | D. Medicine monitoring 🟢🟡🔴, sort/filter, CSV export | all (scoped) |
| `prediction.html` | E. 7/14/30-day forecasts, stock-out dates, risk %, BRICS federated panel | all (scoped) |
| `simulation.html` | F. Emergency what-if with presets | admin, district |
| `redistribution.html` | G. PHC A → PHC B transfers, approve/reject, decision log | all (approve: admin/district) |
| `alerts.html` | H. Stock-out, bed, staff, emergency and expiry alerts | all (scoped) |

## Code layout

```
css/style.css          design system (light + dark)
js/data.js             mock database; each collection maps to a future SQL table
js/engine.js           analytics: forecasting, risk, simulation, redistribution, alerts
js/auth.js             login, session, role-based access, data scoping
js/layout.js           shared UI helpers, sidebar and top bar
js/charts.js           dependency-free SVG charts
js/pages/*.js          one script per page
```

## What makes it different

- **Explainable risk score.** Every PHC's score is broken into medicine, beds, staff and surge points, so officers can see *why* a PHC is at risk.
- **Probabilistic stock-out risk.** Risk % is P(demand > stock) taken from the forecast's uncertainty, not a fixed threshold.
- **Expiry-aware redistribution.** Near-expiry surplus is preferred as a donor source, which cuts both stock-outs and wastage. Donors never drop below their own need.
- **Simulation → action.** A simulated scenario can be turned directly into a redistribution plan.
- **Resilience Index.** One 0–100 number for a district or the whole nation.
- **Federated BRICS panel.** Countries share model updates only. This panel is simulated in the prototype.

## Next steps (backend)

1. Python (Flask/FastAPI) API with the same shapes as `DB` and `Engine`.
2. SQL tables: `districts`, `phcs`, `medicines`, `stock`, `footfall_daily`, `staff_daily`, `transfers`, `alerts`, `users`.
3. Move the `engine.js` logic to Python (statsmodels / scikit-learn), and replace demo login with hashed passwords and tokens.

> Demo passwords live in `auth.js` for the prototype only. Real authentication must happen on the server.
