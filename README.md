# JR Promotions: Stock & Logistics System

A web-based warehouse and logistics system for JR Promotions (South Africa). It tracks promotional stock (samples, giveaways, POS material, equipment, uniforms) from the moment a client delivers it to a warehouse, out to promoters in the field, and back again.

## Who uses it and what they do

| Role | What they see and do |
|---|---|
| **Director** | Everything: stock value in Rand, all warehouses, clients and campaigns. Manages staff accounts. |
| **Office staff** | Same as directors, except managing staff accounts. |
| **Account manager** | Their own clients only. Creates campaigns, assigns promoters, approves (or trims, or rejects) promoter stock requests, and tracks campaign stock usage and cost. |
| **Warehouse staff** | Receives deliveries (GRN), works the dispatch queue (pick, then dispatch with courier and waybill), checks in returns, transfers between warehouses, and does stock takes. Sees quantities but not Rand values. |
| **Promoter** | Phone-friendly. Requests stock for their campaigns, confirms deliveries, logs what they handed out at each store activation, and returns leftovers. |

## The stock flow

```
Client delivery ──receive──▶ Warehouse ──dispatch──▶ Promoter ──usage report──▶ consumed
                              ▲   │                     │
                              │   └─transfer─▶ other warehouse
                              └──────────return (good / damaged)─┘
```

1. **Request**: a promoter (or account manager) asks for stock for a campaign from a specific warehouse. If the campaign's own account manager raises it, it is approved straight away.
2. **Approve**: the account manager approves it, trimming quantities if needed. Approval is blocked if the warehouse doesn't have enough *free* stock (stock already promised to other approved requests counts as allocated).
3. **Pick and dispatch**: the warehouse prints a picking slip with bin locations, then dispatches. Stock moves from the warehouse into the promoter's hands. Courier deliveries need a waybill number.
4. **Deliver**: the promoter confirms they received it.
5. **Activation reports**: the promoter logs what was handed out or damaged at each store, which reduces what they hold.
6. **Return**: leftovers are logged for return; the warehouse checks them in, separating good units (back into stock) from damaged ones (written off).

Every stock change is written to an **immutable ledger** (`movements`), so on-hand figures can always be traced back. Each campaign shows a reconciliation: *dispatched = used + damaged + returned + still with promoters*.

## Features

- Dashboards for each role: stock value, low-stock alerts, approval and dispatch queues, a 30-day stock flow chart, and stock by warehouse and by client
- Multi-warehouse stock with bin locations (seeded with Midrand, Montague Gardens and Pinetown)
- Reorder levels and low-stock highlighting
- Stock takes that post count variances as adjustments
- A view of stock still with promoters, flagging stock on campaigns that have already ended
- CSV exports of stock levels and the ledger (opens in Excel; guarded against formula injection)
- Rand (ZAR) valuation, SA provinces, en-ZA formatting
- Works on phones (promoters) and desktops (office and warehouse)

## Running it

Requires **Node.js 22.13 or newer**. It uses Node's built-in SQLite, so there is no database server to install.

```bash
npm install
npm start            # http://localhost:3000
```

On first start with an empty database it loads **demo data** (fictional clients and staff). All demo passwords are `password123`:

| Role | Email |
|---|---|
| Director | `director@jrpromo.test` |
| Office staff | `office@jrpromo.test` |
| Account manager | `lerato@jrpromo.test`, `pieter@jrpromo.test` |
| Warehouse | `warehouse@jrpromo.test` (JHB), `charlene@…` (CPT), `ashwin@…` (DBN) |
| Promoter | `promoter@jrpromo.test`, `kagiso@…`, `zanele@…`, `liam@…`, `ayanda@…` |

`npm run seed` wipes the database and reloads the demo data.

### Going live with real data

Start with an empty database and a single director account instead of demo data:

```bash
ADMIN_EMAIL=you@jrpromotions.co.za ADMIN_PASSWORD='a-strong-password' ADMIN_NAME='Your Name' npm start
```

Then sign in and set up, in this order: **Warehouses → Staff & users → Clients → Products** (from Stock on hand), then **Receive stock** to load opening balances.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `data/jr-promo.db` | SQLite database file |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | | Create the first director instead of loading demo data (empty database only) |

### Hosting notes

- The database is a single file. Host on something with a **persistent disk** (a small VPS, Railway or Render with a volume, an office server). Serverless platforms with ephemeral filesystems will lose data.
- Back up by copying `data/jr-promo.db` (for example with `sqlite3 data/jr-promo.db ".backup backup.db"`) on a schedule.
- Put it behind HTTPS (for example Caddy or nginx) before staff use it over the internet.

## Development

```bash
npm test
```

The tests run the API end to end against an in-memory database: the full request → approve → dispatch → deliver → use → return cycle, role permissions, over-allocation blocking, transaction rollback, and a check that the ledger reconciles with stock on hand for every product.

### Project layout

```
src/
  server.js         start-up, first-run seeding
  app.js            Express app and route wiring
  db.js             schema and transaction helper
  auth.js           password hashing, sessions, role checks
  access.js         row-level rules (who can see which campaign)
  stock.js          all stock changes and ledger writes go through here
  routes/
    admin.js        login, users, warehouses, clients
    inventory.js    products, receive, transfer, stock take, ledger, CSV
    campaigns.js    campaigns and reconciliation
    workflow.js     stock requests, returns, activation reports
    dashboard.js    role dashboards
  seed.js           demo data
public/             single-page frontend (plain JS, no build step)
test/               API tests (node:test)
```
