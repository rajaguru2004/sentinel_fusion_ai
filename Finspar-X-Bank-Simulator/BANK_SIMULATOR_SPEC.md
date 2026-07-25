# FinSpark Bank Simulator — Build Specification

Living spec for the banking platform layer of the AI-Powered Banking Fraud Prevention Platform.
Sits in front of the existing `sentinel_fusion_ai` ML engine.

Last updated: 2026-07-22

---

## 1. Purpose & current scope

Build a high-fidelity **Indian corporate internet banking** simulator so the fraud engine can be
demonstrated inside a realistic banking environment instead of a terminal.

**Scope guard:** India only. No overseas customers, no multi-country logic. Currency INR only.

### In scope now — the banking simulator

Auth, account screens, beneficiary lifecycle, payment initiation and modification, ledger,
disputes, and the UI shell. Everything works end to end **without** the fraud engine attached.

### Out of scope now — ML integration

The connection to `sentinel_fusion_ai` is owned by another team member and lands later.
See §12 *Future implementation*.

This build must therefore ship the **integration seams** — hook points, event payloads, risk
fields on the data model, and status values the engine will drive — but leave the scoring itself
stubbed. A stub scorer returns `LOW` for everything so flows stay testable.

---

## 2. Reference material

| Source | What is taken | What is NOT taken |
|---|---|---|
| `D:\SHIS HRM\human-resource-management` | Tech stack + monorepo shape only | No schema, modules, components, config, or business logic |
| IndusInd IndusDirect screenshots | Screen structure, field lists, UX flow | No branding, no real customer data |

All application code is written from zero for the banking domain.

---

## 3. Tech stack

### Backend
- NestJS 11 + TypeScript 5.7
- Prisma 5.22 + PostgreSQL 15
- Auth: `@nestjs/jwt` + `passport-jwt` + `bcryptjs`
- Validation: `class-validator` + `class-transformer` + `zod`
- `@nestjs/swagger` (API docs), `@nestjs/schedule` (cut-off jobs, cron)
- `nodemailer` (OTP + notification email over SMTP)
- `axios` (reserved for the future ML scoring service)

### Frontend
- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS v4
- TanStack Query (server state) + zustand (client state)
- react-hook-form + `@hookform/resolvers` + zod
- axios, lucide-react, recharts, sonner, clsx, tailwind-merge

### ML service — later
Python 3.12 + FastAPI wrapping `ml.predict.SentinelScorer`. Not built in this phase.

### Deliberately excluded from the reference stack
MinIO, TensorFlow.js, face-api, MCP SDK, exceljs, tiptap, fullcalendar,
dnd-kit, next-intl, swiper, reactflow, `@supabase/*`, `canvas`, `bcrypt` (native).

---

## 4. Environment

Verified on the target machine:

| Item | Version / status |
|---|---|
| Windows + WSL 2 | enabled, default version 2, no distro needed |
| Docker Engine | 29.6.2 |
| Docker Compose | v5.3.1 |
| Node.js | v24.14.0 |
| npm | 11.9.0 |
| Python (host) | 3.14.3 — not used; ML runs in a 3.12 container |

Nothing further to install. PostgreSQL and Prisma arrive via container and npm respectively.

Docker Desktop disk image location must point at `D:\docker\dockerdata`
(Settings → Resources → **Advanced**, not File sharing).

---

## 5. Architecture

```
┌──────────────┐           ┌──────────────┐           ┌ ─ ─ ─ ─ ─ ─ ─ ─ ┐
│  Next.js     │ ────────► │  NestJS      │ ─ ─ ─ ─ ► │  FastAPI scorer
│  frontend    │           │  backend     │           │  (phase 2)      │
│  :3000       │ ◄──────── │  :3001       │ ◄ ─ ─ ─ ─ │  :8000
└──────────────┘           └──┬────────┬──┘           └ ─ ─ ─ ─ ─ ─ ─ ─ ┘
                              │        │
                   ┌──────────▼──┐  ┌──▼──────────────┐
                   │ PostgreSQL  │  │ Zoho SMTP       │
                   │ :5432       │  │ (OTP email)     │
                   └─────────────┘  └─────────────────┘
```

Dashed = phase 2. Until then the backend calls an in-process `StubScorer`.

### Compose services (phase 1)
| Service | Image / build | Host port |
|---|---|---|
| `postgres` | `postgres:16-alpine` | 5432 |
| `backend` | build `apps/backend`, `node:24-slim` | 3001 |
| `frontend` | build `apps/frontend`, `node:24-slim` | 3000 |

Backend waits on a postgres healthcheck. Frontend waits on backend.

### Environment variables

`apps/backend/.env` — **gitignored, never committed**.

```
DATABASE_URL=postgresql://finspark:<pass>@postgres:5432/finspark
JWT_SECRET=<secret>
JWT_EXPIRES_IN=15m

SMTP_HOST=smtp.zoho.in
SMTP_PORT=465
SMTP_SECURE=true
EMAIL_USER=<zoho mailbox>
EMAIL_PASS=<zoho app password>
EMAIL_USER_TO=<demo recipient>

OTP_TTL_SECONDS=100
OTP_MAX_ATTEMPTS=3
LOGIN_MAX_ATTEMPTS=5
```

`apps/backend/.env.example` carries the same keys with empty values and **is** committed.

Actual values live only in the local `.env`. Zoho requires an **app-specific password**
(Zoho Mail → Settings → Security → App Passwords) when 2FA is on; the account password will
fail SMTP auth. Rotate the password if it has ever been pasted into a chat, ticket or commit.

### Repo layout

```
D:\FinSpark\
├── sentinel_fusion_ai\        existing ML engine (untouched)
└── bank-simulator\
    ├── apps\
    │   ├── backend\           NestJS
    │   └── frontend\          Next.js
    ├── services\
    │   └── scorer\            FastAPI wrapper over SentinelScorer
    ├── docker-compose.yml
    └── BANK_SIMULATOR_SPEC.md
```

---

## 6. Domain model — India specifics

### Identity
- **Customer Id** — the corporate entity (e.g. `83840226`)
- **User Id** — a person operating under that entity (e.g. `TARAKESH`)
- One Customer has many Users. One User may access several Customers.

### Roles (maker-checker)
| Role | Can do |
|---|---|
| Maker | initiate transfers, add beneficiaries |
| Authorizer / Checker | approve transfers, activate beneficiaries |
| Viewer | read-only |

### Two credentials per user
| Credential | Used for |
|---|---|
| Login Password | portal access |
| Transaction Password | authorizing money movement |

Transaction Password may also be server-generated via *Generate Or Reset Txn Password*
(OTP to registered mobile, 100-second validity).

### Payment rails
| Rail | Timing | Notes |
|---|---|---|
| IFT (internal transfer) | 24×7 | same-bank, no IFSC needed |
| IMPS | 24×7 | instant |
| NEFT | cut-off 19:30 | batch |
| RTGS | cut-off 19:30 | high value |

Per-transaction / cumulative limit: **INR 25,00,000**.
Transactions past cut-off or over limit go to **HOLD** and process next working day.

### Field formats
| Field | Rule |
|---|---|
| Account Number | alphanumeric, no special chars, max 35 |
| IFSC Code | alphanumeric, exactly 11 chars, `^[A-Z]{4}0[A-Z0-9]{6}$` |
| Beneficiary Code | alphanumeric, unique per customer, max 20 |
| Beneficiary Name | letters/numbers/spaces, max 100 |
| Dates | `DD/MM/YYYY` |
| Amounts | Indian grouping — `₹72,201.96`, `₹4,60,000.00` (lakh/crore) |

### Money storage
All amounts stored as **BigInt paise**. Never float.
`72201.96` → `7220196`.

### Balance model
Stored columns:
| Column | Meaning |
|---|---|
| `clearBalance` | settled funds |
| `fundsInClearing` | pending credits not yet settled |
| `holdAmount` | liens **and fraud holds** — the gateway writes here |
| `fdBalance` | linked FD/TD |

Derived (never stored):
```
availableBalance   = clearBalance - holdAmount
effectiveAvailable = availableBalance + fdBalance
```

The Account Balance screen displays all five values.

---

## 7. Navigation (final)

Single shell. Collapsible left sidebar + top bar. The reference product's two-shell
(portal → "Go to Application" → inner app) design is **collapsed into one**.

```
Dashboard
Account ▾
  ├─ Account Balance
  ├─ Account Statement
  ├─ Mini Statement
  └─ Portfolio Statement
Beneficiary ▾
  ├─ Beneficiary Maintenance
  ├─ Activate Beneficiary
  └─ Delete Beneficiary
Payments ▾
  ├─ Initiate Payments
  └─ Modify Payments
Profile
Change Password
Transaction Password
Dispute Resolution ▾
  ├─ Report Fraudulent Transaction
  ├─ Track Request
  └─ Grievance Redressal
Log out
```

**Top bar:** hamburger · logo · `Last Login: <timestamp>` · notification bell + unread count ·
`Welcome !! <USERNAME> (<CustomerId>)`

### Dropped from the reference
- ERP Plugin (entire menu)
- Account: Interest Certificate, FD, Loan, Cheque Book
- Beneficiary: File Upload, File Status, Authorize Beneficiary Deletion
- Administration: Stock Statement, Bank Administration, Fintech
- Payments: Cheque Enquiry/Stop, Authorisation
- Top-level: ETax, Statutory Payment (Reports / Bill Payments / Settings — pending decision)

---

## 8. Screen specifications

### 8.1 Login

Route `/login`. Public.

| Field | Type | Required |
|---|---|---|
| Customer Id | text | yes |
| User Id | text | yes |
| Password | password + reveal toggle | yes |
| Enable Virtual Keyboard | checkbox | no |
| CAPTCHA | image + refresh + audio | yes |

Actions: `Login` (disabled until valid) · `Forgot Login Password?` · `Unlock Me` · `Forgot User Id?`
Side panels: portal description, Terms & Conditions link, virtual keyboard help.

Behaviour:
- Account locks after `LOGIN_MAX_ATTEMPTS` (5) consecutive failures
- Virtual keyboard = on-screen keypad, anti-keylogger
- On success record a `LoginEvent` (device fingerprint, IP, user agent, timestamp)

#### 8.1.1 Recovery flows

All three recovery paths share one pattern: **identify → OTP by email → act**.
Every step is rate-limited and every outcome is written to `AuditLog`.

**Forgot User Id** — `/auth/forgot-user-id`

1. Enter `Customer Id` + `Registered Email` (or registered mobile)
2. Server matches; **always** returns the same neutral message whether or not a match was found
   (`If the details match our records, your User Id has been emailed.`)
3. On a real match, email the User Id **masked** — `TAR****SH` — never the full id in plain text

Rationale: an unmasked, unauthenticated User Id lookup hands an attacker half the login triple.

**Forgot Login Password** — `/auth/forgot-password`

1. Enter `Customer Id` + `User Id`
2. OTP emailed to the registered address, `OTP_TTL_SECONDS` validity, `OTP Request ID` shown
3. Verify OTP — max `OTP_MAX_ATTEMPTS` (3), then the challenge is burned and must be re-requested
4. Set new password — new value must differ from the last 3 password hashes
5. All active sessions for that user are revoked; a confirmation email is sent

The same flow with `purpose = TXN_PASSWORD` backs *Generate Or Reset Txn Password* (§8.14).

**Unlock Me** — `/auth/unlock`

Used when the account is locked by failed attempts.

1. Enter `Customer Id` + `User Id`
2. If the account is not locked, return the neutral message and stop
3. OTP emailed, verified as above
4. On success: `failedAttempts → 0`, `lockedAt → null`, unlock email sent

Unlock does **not** reset the password. A user who has forgotten it must run Forgot Login
Password afterwards.

**Shared rules**

| Rule | Value |
|---|---|
| OTP validity | 100 s |
| OTP verify attempts | 3, then burn |
| Resend cooldown | 30 s, max 3 resends per challenge |
| Requests per identity | 5 per hour |
| Response on unknown identity | identical neutral message, identical timing |
| Lock trigger | 5 consecutive failed logins |

Never reveal whether a Customer Id or User Id exists. Uniform responses on all recovery
endpoints, otherwise these become account-enumeration oracles.

Every recovery event is a fraud signal in phase 2: unlock-then-immediately-transfer, or
password-reset from a new device, are classic account-takeover chains.

### 8.2 Dashboard

Route `/dashboard`. Absorbs the reference landing page.

Three regions:
1. **Last successful login on** — timestamp (fraud control: user spots unauthorized access)
2. **Alerts** — pending transaction count, transactions on hold, security notices
3. **Information** — cut-off timings, per-transaction limit, OTP validity

Pending Transactions count is live and links to the authorization queue.

### 8.3 Account Balance

Route `/account/balance`.

Filters: `Customer*` (select) · `Currency` (select, INR only) · `Account Type*` (radio: Savings/Current | FD/TD)
Header actions: `Download Balance` · `Clear`

Table (paginated):
`Account Number | Account Name | CCY | Available Bal | Effective Available Bal | Clear Balance | Funds in Clearing | FD Balance`

### 8.4 Account Statement

Route `/account/statement`.

Filters: `Customer*` · `Account Number*` (+ lookup) · `From Date` · `To Date` (DD/MM/YYYY)
Radios:
- Transaction display type — Today | Yesterday | Historical Statement
- Transaction display order — Descending | Ascending

Actions: `View` · `Download` (Excel / PDF) · `Cancel`

Statement rows show a **risk badge** where the fraud engine scored the transaction.

### 8.5 Mini Statement

Route `/account/mini-statement`.

Filters: `Customer` · `Account Number`
**Table view only** — no Excel/PDF/Word download (differs from reference).
Shows last N transactions (default 10).

### 8.6 Portfolio Statement

Route `/account/portfolio`.

Filter: `Customer*`
Table: `Account Name | Account Number | Available Amount | Currency | Scheme Type`
Scheme Type codes e.g. `CAA` = current account.

### 8.7 Beneficiary Maintenance

Route `/beneficiary/maintenance`. Two-step wizard: **1 Initiate → 2 Confirmation**.

**Option** radio: `Add` | `Modify`

**Beneficiary Details**
| Field | Required |
|---|---|
| Customer | yes |
| Beneficiary Code | yes (unique, max 20) |
| Beneficiary Name | yes (max 100) |
| Address Line 1 / 2 | no |
| Country | fixed `INDIA` |
| State | select |
| City | select |
| Pin Code | no |
| Phone | no |
| Email ID | no |

**Transaction Type Details**
`Beneficiary Type*` — checkboxes: `IFT` `RTGS` `NEFT` `IMPS` (multi-select)

**Bank Details** — appears once a non-IFT type is ticked
| Field | Required | Note |
|---|---|---|
| Account Number | yes | other than own-bank account |
| Confirm Account Number | yes | must match |
| IFSC Code | yes | not applicable for own-bank transfer |

Actions: `Fetch Beneficiary` · `Next` · `Cancel`
- `Fetch Beneficiary` resolves the account holder name from the destination bank
- Fetched name shown read-only as **Beneficiary Name as Fetched**
- A name mismatch between entered and fetched name is a **fraud signal**

**Modify mode:** `Get Details` button + lookup modal.

**Select beneficiary modal** — search by `CustomerId` (read-only) + `Beneficiary Code`.
Table: `Beneficiary Code | Beneficiary Name | Own Bank Account | Other Bank Account Number | IFT | RTGS | NEFT | IMPS | DD | Cheque | Status | Beneficiary Name as Fetched`
Paginated with first/prev/page/next/last controls.

**New beneficiaries are created in `PENDING` status — not usable for transfers until activated.**

### 8.8 Activate Beneficiary

Route `/beneficiary/activate`. Authorizer role only.

`Authorisation process*` radio: `Beneficiary wise` | `Filewise`
Filters: `Customer*` · `Beneficiary code`
Actions: `Search` · `Activate` · `Reject`
Shows `Number of Beneficiaries found: <n>`, then a selectable result table.

On activation: status `PENDING → ACTIVE`, `activatedAt` stamped.
**Cooling period** — a newly activated beneficiary is high-risk for the first 30 minutes
and for transfers above ₹50,000 (RBI-style control, and a fraud engine feature).

### 8.9 Delete Beneficiary

Route `/beneficiary/delete`. Same shape as Activate.

Filters: `Customer*` · `Beneficiary code` → `Search` → select rows → `Delete`
Soft delete: status → `DELETED`, `deletedAt` stamped. Historical transactions keep their reference.

### 8.10 Initiate Payments

Route `/payments/initiate`.

#### Step 0 — Payment Mode selection

Card `Payment Mode`, radio group laid out 3 per row:

| Mode | Rail |
|---|---|
| Fund Transfer - Own Bank Account | IFT |
| Fund Transfer - Other Bank (RTGS) | RTGS |
| Fund Transfer - Other Bank (NEFT) | NEFT |
| IMPS | IMPS |

Four modes only. `Bill Payment`, `CBDT` and `GST` are **removed** — not built.

Selecting a mode opens the wizard. The chosen mode is then shown as a dropdown at the top of the
wizard with a `<Back` button in the card header.

#### Wizard: `1 Initiate Payment ── 2 Preview ── 3 Confirmation`

**Step 1 — Initiate Payment**

Section `Initiate Payment`:

| Field | Type | Required | Notes |
|---|---|---|---|
| Cust Ref # | text | yes | max 35 alphanumeric, no special chars, unique per transaction per financial year; first 15 chars appear in account statements |
| Payment Mode | text | — | read-only, mirrors the selection |
| Amount (INR) | number | yes | up to 18 digits including 2 decimals |
| Amount in Words | text | — | read-only, auto-generated (`One Thousand Rupees Only`) |
| Debit Account | select | yes | label shows live `Balance(INR)` for the selected account |
| Remarks | text | no | |
| Mode of Payment | radio | yes | `Using IFSC Code / Account Number` \| `Using MMID` — IMPS only |

Section `Beneficiary Details`:

| Field | Type | Required | Notes |
|---|---|---|---|
| Beneficiary Code | text + lookup button | yes | opens Select-beneficiary modal |
| Name | text | yes | auto-filled, read-only |
| Email ID | text + `+` button | no | `+` adds another email row |
| Phone | text | no | auto-filled |
| Account Number | text | yes | auto-filled, read-only |
| Confirm Account Number | text | no | auto-filled |
| IFSC | text | yes | auto-filled, read-only |
| Beneficiary Name as fetched | text | — | read-only, resolved from destination bank |

Actions: `Fetch Beneficiary` · `Next` · `Cancel`
Footer note: *To add a beneficiary, go to Beneficiary → Beneficiary Maintenance.*

Only **ACTIVE** beneficiaries appear here. Pending ones are not selectable.

**Select beneficiary modal (payment variant)** — differs from the maintenance variant.
Search field: `Beneficiary Code/Name`.
Table: `Account NO | Beneficiary Name | Bank Name | Branch Name | Beneficiary Code | Beneficiary Name Lookup`
Paginated first/prev/page/next/last.

**Step 2 — Preview**

Read-only mirror of everything entered, in two cards `Payment Details` and `Beneficiary Details`.
Beneficiary card shows `IFSC/NBIN` (NBIN when MMID mode was used).

Actions: `Back` · `Confirm` · `Cancel`

Red footer warning: *RTGS/NEFT fund transfers are effected solely on the beneficiary account
number, not the beneficiary name.*

**Verify Transaction Password and OTP modal** — opens on `Confirm`.

| Field | Required |
|---|---|
| Transaction Password | yes |
| OTP | yes |

Also shows `Resend OTP` link and `OTP Request ID :<id>`. Actions `Cancel` · `Submit`.

**OTP delivery — email over SMTP.** The reference product sends OTP by SMS; this build sends it
by email through Zoho SMTP (`smtp.zoho.in:465`, TLS) using `nodemailer`, because no SMS gateway
is available. The UI copy says *"OTP sent to your registered email"*.

| Property | Value |
|---|---|
| Code | 6 digits, cryptographically random |
| Storage | bcrypt hash only — never the plain code |
| Validity | 100 s (`OTP_TTL_SECONDS`) |
| Verify attempts | 3, then the challenge is burned |
| Resend | 30 s cooldown, max 3 per challenge |
| Request ID | short numeric id shown in the modal, used for support/debug |

A single `OtpService` serves payments, password reset, transaction-password reset and unlock,
keyed by `purpose`.

**In phase 2 this modal becomes the Decision Engine's MEDIUM-risk challenge surface.** Low-risk
payments still pass through it (bank policy); medium-risk payments additionally require a
re-issued OTP; high/critical payments never reach it — they are held or blocked at `Confirm`.

**Step 3 — Confirmation**

Shows the generated `Reference Number` (format `GX14220726000001` — prefix + DDMMYYYY + serial),
final status, and the risk outcome where the gateway acted.

### 8.11 Modify Payments

Route `/payments/modify`.

Filters:
| Field | Required |
|---|---|
| Reference Number | no |
| Payment Mode | yes |
| Transaction Date (From) | no |
| Transaction Date (To) | no |

Action: `Search`

Result table (paginated):
`Edit | Delete | Reference Number | Amount (₹) | Customer Reference No | Transaction Date | Payment Mode | Status`

`Edit` and `Delete` are inline text links in the first two columns.

Behaviour:
- **Edit** → navigates to `/payments/initiate` in edit mode, wizard step 1, all fields pre-filled
  from the saved payment. The edit screen also carries a `Delete` action so the transaction can be
  removed without going back to the list.
- **Delete** → soft delete after confirmation. Status → `DELETED`. Record retained for audit.

Only payments in an editable status appear. Editable statuses: `NEW`, `PENDING_AUTH`, `HELD`.
Once `PROCESSING` or `COMPLETED`, a payment can no longer be modified or deleted.

Every edit is re-scored by the fraud gateway on save — changing the amount or beneficiary of an
already-scored payment is itself a fraud pattern.

### 8.12 Profile

Route `/profile`. Read-only detail card.
`User Id | Customer Id | Registered Mobile | Registered Email` (+ further fields).

### 8.13 Change Password

Route `/change-password`.
`Old Password*` · `New Password*` · `Confirm Password*` (all with reveal toggles).
Actions: `Update` (disabled until valid) · `Reset` · `Cancel`.

### 8.14 Transaction Password

Route `/transaction-password`.
Same three fields. Actions: `Update` · `Cancel` · `Generate Or Reset Txn Password`.
The generate path sends an OTP to the registered mobile (100-second validity).

### 8.15 Report Fraudulent Transaction

Route `/disputes/report`.

Warning banner: submitting triggers an immediate debit freeze and net-banking deactivation
until the investigation completes.

| Field | Type | Required |
|---|---|---|
| Application Name | select | yes |
| Account | select | yes |
| Transaction | select | yes |
| Currency | select | yes |
| Amount | number | yes |
| Transaction Ref No. | text | yes |
| Fraud Type | select | yes |
| Transaction Date | date | yes |
| Additional Detail | textarea | yes |

Actions: `Submit` · `Reset` · `Cancel`
On submit: create a Case, freeze the account, return a Tracking Reference No.

### 8.16 Track Request

Route `/disputes/track`.

Search by `Tracking Ref No.#*`. Actions `Search` · `Clear`.
Table: `Tracking Reference No. | Request Date | Transaction Ref No. | Last Updated Status | Last Updated Date | Details`
Paginated, default 5 per page.

### 8.17 Grievance Redressal

Route `/disputes/grievance`. Spec pending.

---

## 9. Fraud Detection Gateway — seams now, engine later

**Phase 1 builds the gateway shell and every integration seam. It does not build the scoring.**
A `StubScorer` implementing the same interface returns `{ riskScore: 0.05, riskLevel: 'LOW',
reasons: [] }` so all flows run end to end. Phase 2 swaps the implementation — no call sites
change.

```ts
interface Scorer {
  score(event: UnifiedEvent): Promise<RiskVerdict>;
}
// phase 1: StubScorer   phase 2: HttpScorer -> FastAPI /score
```

What phase 1 must deliver so phase 2 is a drop-in:
- `FraudGateway` service called at every intercept point below
- `UnifiedEvent` builder producing the schema `sentinel_fusion_ai` expects
- `riskScore` / `riskLevel` / `riskReasons` columns populated on `Payment` and `FraudEvent`
- `HELD`, `CHALLENGED`, `BLOCKED` statuses honoured by the ledger and the UI
- `holdAmount` movement working
- Analyst dashboard rendering whatever the scorer returns

Every state-changing money operation routes through the gateway before the ledger is touched.

```
Request → Gateway → build unified-schema event → POST /score (FastAPI)
        → risk_score + risk_level + SHAP reasons
        → Decision Engine → execute | challenge | block
```

### Decision bands
| Risk | Band | Action |
|---|---|---|
| < 0.25 | LOW | approve, execute immediately |
| < 0.50 | MEDIUM | require Transaction Password re-entry + OTP |
| < 0.75 | HIGH | move funds to `holdAmount`, queue for analyst review |
| ≥ 0.75 | CRITICAL | block, raise alert, freeze account |

Bands come from `ml/fusion.py` and match the committed fusion report.

### Intercepted operations
1. Login (device / IP / location anomaly → account takeover scenario)
2. Beneficiary add
3. Beneficiary activation
4. Payment initiation — scored on `Confirm`, before the OTP modal opens
5. Payment modification — re-scored on save (amount or beneficiary change is itself a signal)
6. Scripted / rapid-fire payment bursts (velocity)

### Where each band lands in the payment wizard

| Band | Behaviour at `Confirm` |
|---|---|
| LOW | OTP modal opens as normal, payment posts on submit |
| MEDIUM | OTP modal opens with a re-issued OTP and a visible risk notice |
| HIGH | modal never opens; amount moves to `holdAmount`, status `HELD`, analyst queue |
| CRITICAL | modal never opens; status `BLOCKED`, alert raised, account frozen |

### Event context captured per request
`ip`, `deviceFingerprint`, `userAgent`, `sessionId`, `timestamp`, `amount`, `rail`,
`beneficiaryAgeMinutes`, `isNewBeneficiary`, `txnCountLastHour`, `amountVsUserMean`

`country` is a weak feature here (India-only), so device, IP, velocity and beneficiary-age
signals must carry the load.

### Demonstration scenarios
| # | Scenario | Expected outcome |
|---|---|---|
| 1 | Small transfer to an aged, active beneficiary | LOW → instant approve |
| 2 | ₹18,00,000 to a beneficiary activated 5 minutes ago | MEDIUM/HIGH → OTP or hold |
| 3 | Script fires 200 transfers in 60 s | velocity trips → block + alert |
| 4 | Login from a new device fingerprint, then immediate large transfer | CRITICAL → freeze |
| 5 | Analyst dashboard watching all of the above live | risk scores + SHAP reasons stream in |

---

## 10. Data model sketch (Prisma)

Indicative, not final.

```
Customer          id, customerId, name, status
User              id, userId, passwordHash, txnPasswordHash, mobile, email,
                  status, failedAttempts, lockedAt, lastLoginAt
CustomerUser      customerId, userId, role (MAKER | AUTHORIZER | VIEWER)

Account           id, customerId, accountNumber, accountName, accountType,
                  schemeType, currency,
                  clearBalance, fundsInClearing, holdAmount, fdBalance   (all BigInt paise)

Beneficiary       id, customerId, code, name, nameAsFetched,
                  accountNumber, ifsc, isOwnBank,
                  allowIFT, allowRTGS, allowNEFT, allowIMPS,
                  addressLine1, addressLine2, state, city, pinCode, phone, email,
                  status (PENDING | ACTIVE | REJECTED | DELETED),
                  createdBy, activatedBy, activatedAt, deletedAt

Payment           id, refNo, custRefNo, customerId, debitAccountId, beneficiaryId,
                  amount (BigInt), amountInWords, rail, paymentMode,
                  transferMode (IFSC_ACCOUNT | MMID), remarks,
                  status (NEW | PENDING_AUTH | HELD | CHALLENGED | BLOCKED | PROCESSING | COMPLETED | FAILED | REJECTED | DELETED),
                  riskScore, riskLevel, riskReasons (Json),
                  initiatedBy, authorizedBy, createdAt, updatedAt, valueDate, postedAt, deletedAt

OtpChallenge      id, paymentId, requestId, codeHash, attempts,
                  expiresAt (issuedAt + 100s), consumedAt, resentCount

LedgerEntry       id, paymentId, accountId, direction (DEBIT | CREDIT),
                  amount (BigInt), balanceAfter (BigInt), postedAt

FraudEvent        id, paymentId?, userId, eventType, riskScore, riskLevel,
                  modelScores (Json), shapReasons (Json), decision, ip,
                  deviceFingerprint, createdAt

Case              id, trackingRef, customerId, paymentId?, source (AI_FLAGGED | CUSTOMER_REPORTED),
                  fraudType, amount, status, assignedTo, resolution, createdAt, updatedAt
CaseNote          id, caseId, authorId, body, createdAt

LoginEvent        id, userId, customerId, ip, deviceFingerprint, userAgent,
                  success, riskScore, createdAt

AuditLog          id, actorId, action, entity, entityId, before (Json), after (Json), ip, createdAt
```

Ledger uses double entry: every payment writes matched DEBIT and CREDIT rows.
Balances are recomputed from the ledger, never mutated blind.

`Payment.refNo` format: `GX` + `DDMMYYYY` + 6-digit serial, e.g. `GX14220726000001`.
`Payment.custRefNo` is user-supplied and must be unique per customer per financial year.

---

## 11. Design direction

**Take the information architecture from the reference. Discard its visual language.**

The reference is a 2017-era enterprise portal — maroon chrome, dense tables, grey disabled
buttons, no whitespace. Field lists and flows are worth copying. The look is not. This build is
judged on screen, so the UI has to read as a modern fintech product while still being obviously
a *bank*.

### Palette

Security product, not a consumer wallet. Deep navy base, single electric accent, risk colours
that carry real meaning.

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#F8FAFC` | `#0B1120` |
| `--surface` | `#FFFFFF` | `#111A2E` |
| `--surface-raised` | `#FFFFFF` | `#16203A` |
| `--border` | `#E2E8F0` | `#1E293B` |
| `--text` | `#0F172A` | `#E2E8F0` |
| `--text-muted` | `#64748B` | `#94A3B8` |
| `--primary` | `#1E3A8A` navy | `#3B82F6` |
| `--accent` | `#06B6D4` cyan | `#22D3EE` |

Risk scale — used for badges, score meters and the analyst feed:

| Band | Colour | Token |
|---|---|---|
| LOW | emerald `#059669` | `--risk-low` |
| MEDIUM | amber `#D97706` | `--risk-medium` |
| HIGH | orange `#EA580C` | `--risk-high` |
| CRITICAL | red `#DC2626` | `--risk-critical` |

Dark mode ships from day one — it makes the analyst dashboard look like a real SOC and it demos
well under projector lighting.

### Type & spacing

- `Inter` (UI) and `JetBrains Mono` (account numbers, reference numbers, amounts)
- Tabular figures for every monetary column — digits must align
- 4px spacing scale, generous card padding (24px), 8px radius on inputs, 12px on cards

### Component conventions

| Element | Treatment |
|---|---|
| Card | white/`--surface`, 1px border, soft shadow, **no coloured header bar** — title sits inside |
| Card actions | top-right, ghost or outline buttons |
| Primary button | solid `--primary`, white text, subtle lift on hover |
| Disabled button | reduced opacity, not battleship grey |
| Input | floating label, 1px border, `--accent` focus ring, inline error text below |
| Required | subtle `*` in `--text-muted`, not shouting red |
| Table | zebra-free, hairline row separators, sticky header, right-aligned numerics |
| Stepper | horizontal, filled circle for current, check for done, connecting line |
| Modal | centred, backdrop blur, scale-in |
| Toast | `sonner`, bottom-right |
| Empty state | icon + one line + primary action, never a bare empty table |
| Loading | skeletons, never spinners on full pages |

### Motion

`framer-motion`, restrained. Page transitions 150 ms fade+rise. Modal scale-in 120 ms.
Risk meter animates from 0 to its score on reveal — the one place a flourish earns its keep.
Respect `prefers-reduced-motion`.

### Signature moments — build these deliberately

These are what judges remember:

1. **Risk meter** — animated 0–100 arc, colour-shifting by band, on the payment confirmation
2. **Live transaction feed** — rows streaming in with risk badges, on the analyst dashboard
3. **Explanation card** — plain-language reasons stacked as chips, not a JSON dump
4. **Balance card** — large tabular amount, sparkline of recent movement
5. **Hold banner** — when funds are held, an unmistakable amber band across the screen

Items 1–4 are stubbed in phase 1 with placeholder data and wired to the real engine in phase 2.

### Amount formatting

Indian grouping everywhere: `₹72,201.96`, `₹4,60,000.00`, `₹25,00,000.00`.
Never `₹460,000.00`. Rendered by one shared `formatINR()` helper — no ad-hoc formatting.

FinSpark uses its own brand name and logo. No IndusInd assets, colours or copy.

---

## 12. Build order

### Phase 1 — banking simulator (this build)

1. Scaffold monorepo, docker-compose, Prisma schema, first migration
2. Seed: 1 customer, 3 users, 2 accounts, 8 beneficiaries — fabricated Indian data
3. Design system: tokens, dark mode, shared components (Card, Input, Table, Stepper, Modal, Badge)
4. Auth: login, lockout, JWT + role guards, both password types
5. `OtpService` + Zoho SMTP mailer, shared by payments and all recovery flows
6. Recovery: Forgot User Id, Forgot Login Password, Unlock Me
7. Shell: sidebar, top bar, layout, notifications
8. Account screens (balance, statement, mini, portfolio)
9. Beneficiary screens (maintenance, activate, delete)
10. Payments: mode selection, 3-step wizard, OTP modal, modify/edit/delete
11. Ledger posting, hold handling, cut-off scheduler
12. `FraudGateway` + `StubScorer` + `UnifiedEvent` builder wired into every intercept point
13. Dispute screens (report, track, grievance)
14. Analyst dashboard shell with stubbed risk data

### Phase 2 — ML integration (owned by another team member)

15. FastAPI scorer service wrapping `ml.predict.SentinelScorer`
16. Swap `StubScorer` → `HttpScorer`
17. Decision Engine bands driving hold / challenge / block
18. SHAP explanations rendered in the analyst dashboard
19. Attack scripts for demo scenarios 3 and 4

---

## 12a. Future implementation

Deliberately deferred. Recorded so the seams are not designed away.

| Item | Note |
|---|---|
| ML engine connection | Owned by another team member. Phase 1 ships `StubScorer` behind the `Scorer` interface. |
| FastAPI scorer container | Added to `docker-compose.yml` in phase 2. |
| SHAP explanation rendering | Card component exists in phase 1 with placeholder reasons. |
| Live analyst feed | Phase 1 polls; phase 2 may move to SSE/WebSocket if latency demands. |
| Device fingerprinting | Phase 1 captures a basic fingerprint into `LoginEvent`; phase 2 consumes it as a feature. |
| SMS OTP | Email only for now. A gateway can be added behind `OtpService` without touching callers. |
| Maker-checker authorization queue | See open items. |

---

## 13. Open items

- **Maker-checker**: the `Payments → Authorisation` menu was dropped, so there is currently no
  screen for an Authorizer to approve a maker's payment. Either the roles collapse to a single
  operator (OTP is then the only control), or an authorization queue is added back later.
  Decision needed before the Prisma schema is frozen.
- Whether Reports / Settings top-level menus survive
- Grievance Redressal screen spec
- Analyst dashboard design (no reference screenshots — will be designed fresh)
- Notification bell behaviour and content
- MMID transfer mode: build the MMID path or restrict IMPS to IFSC + account number

---

## 14. Data handling note

The reference screenshots contain a live Customer Id, mobile number and email address.
None of that data is used. All seed data is fabricated Indian test data.

Secrets — SMTP credentials, `JWT_SECRET`, database password — live only in `apps/backend/.env`,
which is gitignored. `.env.example` holds the key names with empty values. No credential appears
in this document, in seed files, or in any committed source.

Use a Zoho **app-specific password** for SMTP, not the mailbox account password. If an account
password has been pasted anywhere outside the `.env` file, rotate it.
