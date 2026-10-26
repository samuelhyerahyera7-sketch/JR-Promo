# JR Promotions: Stock & Logistics System

A web-based warehouse and logistics system for JR Promotions (South Africa). It tracks promotional stock (samples, giveaways, POS material, promoter tables and setups, uniforms) from the moment a delivery arrives at a warehouse, out to promoters in the field, and back again.

## Who uses it and what they do

| Role | What they see and do |
|---|---|
| **Director** | Everything: all warehouses, clients and campaigns. Manages staff accounts. |
| **Office staff** | Same as directors, except managing staff accounts. |
| **Account manager** | Their own clients only. Creates campaigns, assigns promoters, approves (or trims, or rejects) promoter stock requests, and tracks campaign stock usage. |
| **Warehouse manager** | Everything warehouse staff can do, plus: adds and edits products and uniform ranges, manages their own team (warehouse staff and promoter accounts, badges), sets up and approves stock counts, writes off expired stock, sees the shrinkage report. Can't create directors, office staff or account managers, or approve their own counts. |
| **Warehouse staff** | Receives deliveries (with waybill photos and expiry dates), runs the **promoter counter** (scan a promoter's badge, issue stock, take returns, all signed on screen), works the dispatch queue, sends uniforms to the laundry, transfers between warehouses, does stock takes, prints QR labels. |
| **Promoter** | Phone-friendly. Shows their QR ID badge at the counter, requests stock (or whole kits), signs for deliveries, logs what they handed out at each store, and returns leftovers. |

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

### Campaign colours on the shelves
- Every campaign has a **named shelf colour** (red, orange, yellow, lime, green, teal, sky blue, blue, purple, pink, brown, grey). New campaigns get the least-used colour automatically. Account managers, office staff and warehouse managers can change it.
- Products are **tagged to the campaign they're shelved for**, either on the product screen or by choosing the campaign when receiving stock. The colour then shows on the stock list (with a filter per campaign), product details, picking slips (each line shows its shelf colour and bin), the dispatch queue, the counter, setups and requests.
- **QR labels & shelf signs**: product labels carry a coloured band with the campaign name, and each campaign has a printable full-width **shelf sign** in its colour, with a QR that opens the campaign.

### Setups & strike downs
- Book where **gazebos, backwall banners, pull-up banners, tables** and other setup kit need to be built and taken down: campaign, venue and address (with directions), on-site contact, setup and strike-down times, crew lead and crew, and the equipment list (kits can be added in one click).
- An **agenda** shows every setup and strike down by day (Overdue, Today, Tomorrow…), colour-coded by campaign.
- Each job goes **Scheduled → Loaded out → Set up → Struck down → Back in warehouse**. Loading out moves the equipment from the warehouse to the crew lead; the crew confirm the setup and strike down on their phones (geotagged, with photos); the warehouse checks everything back in, good or damaged. Anything missing stays against the crew lead.
- Reminders for setups to load out, strike downs due or overdue, setups not confirmed, and equipment not back after a strike down.

### Promoter counter and handovers
- Every promoter has a **QR ID badge** (printable, and on their phone under *My ID badge*). Warehouse staff scan it at the counter to bring up who the promoter is, their uniform size, what's ready to collect, what they hold and what they owe back.
- Every handover is recorded with **who processed it** (the signed-in staff member) **and which promoter** it was for, plus the promoter's **on-screen signature**. Collections are signed at the counter; courier deliveries are signed by the promoter in the app when they arrive. The *Handover log* lists them all.
- **Uniforms must be ticked as clean and ironed** before they can be issued. On return, uniforms are sorted into *good*, *needs wash/iron* (goes to **Laundry** and can't be issued until it's marked clean) or *damaged*.

### Uniforms, tables, setups and giveaways
- Uniforms come in **ladies/mens, colours and sizes**, one SKU per combination. *New uniform range* creates the whole size × colour × cut grid in one go, and the *Uniforms* page shows stock as a size grid.
- **Company-owned stock** (JR's own tables, cloths, gazebos, flags, coolers and uniforms) sits under a "company stock" client and can be used on any campaign.
- **Kits** (e.g. *In-store tasting setup* = table + cloth + cooler) can be added to a stock request in one click.

### Stock per campaign
- Each campaign has a **stock plan** (what it needs in total), showing what's been sent, approved and is still outstanding.

### Expiry dates
- Products can be marked as having an expiry date. They're then received **by batch with an expiry date**, picked **earliest-expiry-first**, and **expired stock is never dispatched** and isn't counted as available. The *Expiry dates* page lists what's expiring, and expired stock can be written off.

### Reminders
Worked out live and cleared automatically once dealt with:
- **Needs to go out:** requests due today, tomorrow or overdue; requests waiting too long for approval; campaigns starting within a week whose planned stock hasn't been sent.
- **Missing or not confirmed:** dispatched stock not confirmed as delivered after 3 days; stock (especially uniforms and tables) still with promoters after a campaign ends; returns that came back short; returns not yet arrived; stock-take shortfalls; recent deliveries without a waybill photo; promoters holding stock with no activation report for 3 days.
- **Stock health:** expired and soon-to-expire batches, low stock, uniforms waiting at the laundry.

### QR codes everywhere
- **Add items** from *Stock on hand*, *QR labels* or straight from *Receive stock* (**+ Add item / + New item**). Each new item shows its QR codes right away, ready to print.
- Every item has its own QR code, and so does each **pack**: drinks in a **6-pack** or a **box of 24** get a pack QR, and scanning it counts all the units in it. A pack can also carry the supplier's box barcode.
- Print **QR labels** for any item or pack (3 across on A4, fits 63×38 mm label sheets). Labels show the product name, and batch labels show the **expiry date**. The QR code itself also holds the name (and pack and expiry), so any ordinary phone camera shows what the label is.
- Scan with a phone camera (or a handheld USB/Bluetooth scanner) to look up an item, add items when receiving or counting (packs add all their units), or open a request from its picking slip.

### Scanning stock out
- **Everything that leaves the warehouse is scanned**: stock issued at the counter, courier and vehicle dispatches, setup load-outs and transfers. The screen ticks off each line as you scan, refuses items that aren't going out, and won't let a box of 24 count when only 6 more should go (open it and scan singles).
- The stock can't be released until the scans match what's going out. If labels are damaged, only the **warehouse manager** (or office/directors) can release it without a full scan, with a reason. Floor staff can't.
- Every scan is logged with who did it, and each request and setup shows "✓ Scanned out" or "Not fully scanned", with the reason and the differences.

### Waybill and delivery photos
- When booking in a delivery, snap the **waybill or delivery note** with the phone camera (or attach a PDF). More photos can be added later under **Deliveries & waybills**, which lists every delivery and flags any without photos.
- Promoters can photograph the courier waybill when confirming a delivery; warehouse staff can add photos to returns (e.g. damage).
- Photos are shrunk on the phone before upload and stored in the database, so one backup file covers everything.

### Stock counts (loss control)
- **Blind counts:** whoever counts never sees the system quantity. They enter what's physically on the shelf (or scan items, one scan per unit) and submit.
- On submit the system compares. Exact matches close straight away. **Small differences** within the tolerance you set (e.g. up to 2 units) are adjusted automatically. **Anything bigger waits for a manager**, and stock isn't changed until then.
- Managers **approve** (stock is adjusted, the ledger records who counted and who approved), **reject** with a reason, or **send for recount** by someone else. **Nobody can approve a count they did themselves** (directors excepted).
- **Daily cycle counts:** one click picks the products counted longest ago (never-counted first, then the most units), in bin order, for a chosen staff member. Reminders flag stock not counted in 90 days.
- **Shrinkage report:** missing, found, damaged and expired units, by warehouse and product, plus each person's counting accuracy.
- Direct stock corrections without a count are manager-only and need a reason.

### Geotags
- The phone's GPS position is recorded on **activation reports** (proving the promoter was at the store), **handovers** (counter collections, delivery confirmations, returns) and **waybill/delivery photos**. Each shows a 📍 link that opens the spot in Google Maps.
- Forms show whether the location was captured. If the phone's location is off or not allowed, the action still goes through, but the activation report is marked *No location* and the account manager gets a reminder.
- Activation reports are only geotagged when promoters log them on their own phone, so office entries don't show the office's location.

### No money
The system works in **units only**. No Rand values, stock valuations or costs are shown anywhere, and the stock-count tolerance is set in units.

### Everything else

- Dashboards for each role: units on hand and with promoters, low-stock alerts, approval and dispatch queues, a 30-day stock flow chart, and stock by warehouse and by client
- Multi-warehouse stock with bin locations (seeded with Midrand, Montague Gardens and Pinetown)
- Reorder levels and low-stock highlighting
- Stock takes that post count variances as adjustments
- A view of stock still with promoters, flagging stock on campaigns that have already ended
- CSV exports of stock levels and the ledger (opens in Excel; guarded against formula injection)
- SA provinces and en-ZA formatting
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
| Warehouse manager | `manager@jrpromo.test` |
| Warehouse | `warehouse@jrpromo.test` (JHB), `charlene@…` (CPT), `ashwin@…` (DBN) |
| Promoter | `promoter@jrpromo.test`, `kagiso@…`, `zanele@…`, `liam@…`, `ayanda@…` |

`npm run seed` wipes the database and reloads the demo data.

### Going live with real data

Start with an empty database and a single director account instead of demo data:

```bash
ADMIN_EMAIL=you@jrpromotions.co.za ADMIN_PASSWORD='a-strong-password' ADMIN_NAME='Your Name' npm start
```

Then sign in and set up, in this order: **Warehouses → Staff & users → Clients → Products** (from Stock on hand), then **Receive stock** to load opening balances.

### Online demo (Vercel)

`api/index.js` and `vercel.json` let the app run on Vercel as a **demo**: the database lives in the function's temporary storage and is refilled with demo data whenever a fresh instance starts, so nothing entered is kept. Use it to try things out, not for real stock.

Set a `SESSION_SECRET` environment variable there: logins then use signed tokens that every copy of the function accepts, instead of a sessions table only one copy can see. Turn on Fluid compute so one copy handles concurrent requests; separate copies still keep separate demo data.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `data/jr-promo.db` | SQLite database file |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | | Create the first director instead of loading demo data (empty database only) |

### Hosting notes

- The database is a single file. Host on something with a **persistent disk** (a small VPS, Railway or Render with a volume, an office server). Serverless platforms with ephemeral filesystems will lose data.
- Back up by copying `data/jr-promo.db` (for example with `sqlite3 data/jr-promo.db ".backup backup.db"`) on a schedule.
- Put it behind HTTPS (for example Caddy or nginx) before staff use it over the internet. **Phone camera scanning and geotags only work over HTTPS** (or on `localhost`); handheld scanners and typing codes work either way.

## Development

```bash
npm test
```

The tests run the API end to end against an in-memory database: the full request → approve → issue (signature + uniform check) → use → return (with laundry) cycle, expiry batches and first-expiry-first-out picking, packs and scanning stock out, uniform ranges, QR/badge scanning, waybill uploads, campaign plans and kits, role permissions, transaction rollback, upgrading an older database, and a final check that the ledger reconciles with warehouse, field and laundry stock (and batch totals) for every product.

### Project layout

```
src/
  server.js         start-up, first-run seeding
  app.js            Express app and route wiring
  db.js             schema, upgrades for older databases, transaction helper
  auth.js           password hashing, sessions, role checks
  access.js         row-level rules (who can see which campaign)
  colours.js        campaign shelf colours
  stock.js          all stock changes and ledger writes go through here (batches, laundry, write-offs)
  scanout.js        reading label codes (items, packs) and checking scans as stock leaves
  routes/
    admin.js        login, users, warehouses, clients
    inventory.js    products, receive, transfer, stock take, ledger, CSV
    campaigns.js    campaigns and reconciliation
    workflow.js     stock requests, returns, activation reports, handovers, promoter counter
    attachments.js  waybill / delivery photos, deliveries list
    reminders.js    live reminders
    counts.js       blind stock counts, approvals, cycle counts, shrinkage report
    setups.js       setups & strike downs
    misc.js         QR codes, scan lookup, kits
    dashboard.js    role dashboards
  seed.js           demo data
public/             single-page frontend (plain JS, no build step)
test/               API tests (node:test)
```
