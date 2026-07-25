# FinSpark — Walkthrough & Run Guide

FinSpark is a high-fidelity **Indian corporate internet-banking simulator** that fronts the
`sentinel_fusion_ai` ML fraud engine. It lets the fraud detection be demonstrated inside a
realistic banking environment instead of a terminal.

- **India only, INR only.** All money is stored as `BigInt` paise (never float).
- **Phase 1 (this build): the banking simulator** — auth, accounts, beneficiaries, payments,
  ledger, disputes, analyst dashboard, and every fraud-engine integration seam.
- **Phase 2 (later, another team member): ML integration** — swap the stub scorer for the real
  FastAPI service. No call sites change.

Full specification: [`bank-simulator/BANK_SIMULATOR_SPEC.md`](bank-simulator/BANK_SIMULATOR_SPEC.md)

---

## 1. What's in the box

```
D:\FinSpark\
├── sentinel_fusion_ai\        existing ML engine (untouched — Phase 2 target)
├── bank-simulator\
│   ├── apps\
│   │   ├── backend\           NestJS 11 + Prisma + PostgreSQL
│   │   └── frontend\          Next.js 16 + React 19 + Tailwind v4
│   ├── docker-compose.yml
│   └── BANK_SIMULATOR_SPEC.md
├── WALKTHROUGH.md             ← this file
└── SESSION_LOG.md             build session record / handoff
```

### Tech stack
| Layer | Stack |
|---|---|
| Backend | NestJS 11, Prisma 5.22, PostgreSQL 16, JWT (passport-jwt), class-validator, nodemailer, @nestjs/schedule |
| Frontend | Next.js 16 (App Router), React 19, Tailwind CSS v4, TanStack Query, zustand, react-hook-form + zod, lucide-react, sonner |
| Infra | Docker Compose (postgres), npm workspaces monorepo |

---

## 2. Prerequisites

Already verified on the target machine:

- **Node.js** ≥ 24, **npm** ≥ 11
- **Docker** (Engine + Compose)
- A local Postgres already occupies host port **5432**, so this project's container is mapped to
  host **5433** (nothing of yours is touched).

No global installs needed — Postgres comes via container, everything else via npm.

---

## 3. How to run

All commands are from `D:\FinSpark\bank-simulator`.

### Step 1 — Start PostgreSQL
```bash
docker compose up -d postgres
```
Container `finspark-postgres` listens on host **5433** (internal 5432).

### Step 2 — Backend (NestJS API)
```bash
cd apps/backend
npm install                 # first time only
npx prisma migrate deploy   # apply migrations (or `prisma migrate dev` in dev)
npm run prisma:seed         # load demo data (idempotent)
npm run start:dev           # http://localhost:3001/api  (Swagger at /api/docs)
```

> **Windows note:** the running dev server locks the Prisma engine DLL. If you need to run
> `prisma generate` or a migration, stop the backend first, run it, then restart.

### Step 3 — Frontend (Next.js)
```bash
cd apps/frontend
npm install                 # first time only
npm run dev                 # http://localhost:3000
```

### Step 4 — Open the app
Go to **http://localhost:3000** → you'll be redirected to the login screen.

---

## 4. Demo credentials

All fabricated test data (see spec §14 — no real customer data is used).

| Field | Value |
|---|---|
| Customer Id | `83840226` |
| User Id | `TARAKESH` (Maker) · `PRIYA_A` (Authorizer) · `ROHIT_V` (Viewer) |
| Login Password | `Finspark@123` |
| Transaction Password | `Txn@12345` |

> `PRIYA_A`'s login password was changed to `NewPass@999` during recovery-flow testing.
> Re-run `npm run prisma:seed` on a fresh DB to reset (upserts don't overwrite existing passwords).

**OTP delivery:** SMTP is optional. With no SMTP credentials configured, OTPs are **printed to the
backend console** (look for `[DEV MAIL]` — the 6-digit code is on the line after
"Your one-time password is:"). To use real email, fill the `SMTP_*` / `EMAIL_*` values in
`apps/backend/.env` with a Zoho **app-specific password**.

---

## 5. Guided demo script

1. **Log in** with the credentials above (note the CAPTCHA + optional on-screen virtual keyboard).
2. **Dashboard** — last login, alert counts, cut-off/limit info.
3. **Account → Account Balance / Statement** — Indian-grouped amounts (`₹72,20,196.50`), risk
   badges on statement rows.
4. **Beneficiary → Maintenance** — add a payee (created **PENDING**); enter a name that differs
   from the fetched name to trigger the **name-mismatch fraud signal**.
5. **Beneficiary → Activate** — activate it (starts a 30-minute high-risk cooling period).
6. **Payments → Initiate Payments:**
   - Small **IMPS** transfer to an aged active beneficiary → **LOW** → OTP → **COMPLETED**
     (watch the animated **risk meter** and the balance drop).
   - **₹18,00,000** to the just-activated beneficiary → **MEDIUM/HIGH** → risk notice / hold.
   - A **NEFT** transfer after 19:30 → **HELD** for the next working day (cut-off rule).
7. **Payments → Modify Payments** — search, see statuses, delete an editable payment.
8. **Dispute Resolution → Report Fraudulent Transaction** — submitting **freezes the account** and
   returns a tracking reference; view it under **Track Request**.
9. **Analyst Dashboard** — live feed of every scored event with risk badges and plain-language
   (SHAP-style) reason chips, band distribution, held/blocked totals, and cases. It polls, so
   actions elsewhere stream in.

---

## 6. The fraud gateway (integration seam)

Every money-moving operation routes through `FraudGateway` **before** the ledger is touched.

```
Request → Gateway → build UnifiedEvent → Scorer.score() → RiskVerdict
        → Decision Engine → execute | challenge (OTP) | hold | block
```

| Band | Score | Action |
|---|---|---|
| LOW | < 0.25 | approve, execute |
| MEDIUM | < 0.50 | require Transaction Password + re-issued OTP |
| HIGH | < 0.75 | move funds to `holdAmount`, queue for analyst |
| CRITICAL | ≥ 0.75 | block, raise alert, freeze account |

**Phase 1 scorer:** a transparent `HeuristicScorer` (beneficiary age, amount vs mean, velocity,
name mismatch) is wired so the demo shows real risk variety. A spec-exact `StubScorer` (always
LOW) is also included. Swapping is **one line** in `apps/backend/src/fraud/fraud.module.ts`
(`{ provide: SCORER, useExisting: ... }`).

**Phase 2:** replace with `HttpScorer` → FastAPI `/score`. No call sites change.

---

## 7. Common commands

```bash
# from bank-simulator/
docker compose up -d postgres      # start DB
docker compose down                # stop everything

# from apps/backend/
npm run start:dev                  # API with hot reload
npm run prisma:studio              # browse the DB in a GUI
npm run prisma:seed                # reload demo data
npm run build                      # compile check

# from apps/frontend/
npm run dev                        # UI with hot reload
npm run build                      # production build / type-check
```

Ports: **3000** frontend · **3001** backend API · **5433** Postgres (host).
