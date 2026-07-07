# Kendo Tournament Management System — v0.3

GitHub Pages (frontend) + GAS Web App (API) + Google Sheets (DB).
English UI. Three access tiers. Standard-seed elimination with court split.

---

## ⚠ Access keys (temporary — change before real use)

| Key | Value | Role |
|---|---|---|
| VIEW_KEY | `view2026` | View only |
| EDIT_KEY | `edit2026` | View + result entry |
| ADMIN_KEY | `admin2026` | Everything (all pre-match setup) |

Change in GAS → Project Settings → Script Properties (no redeploy needed).
Login auto-detects role from the single key. Give View to most members.

---

## Deploy (~10 min)

### A. Sheets + GAS
1. https://sheets.new → create spreadsheet → Extensions → Apps Script
2. Paste `gas/Code.gs`, save
3. Run `initSetup` once (creates 5 sheets + 3 keys; see log)
4. Deploy → New deployment → Web app → Execute as **Me**, Access **Anyone** → copy `/exec` URL
   - Later edits: Manage deployments → edit existing → **New version** (keeps URL)

### B. GitHub Pages
1. New public repo → put the 3 `frontend/` files at root → push
2. Settings → Pages → main / root → open the URL

### C. First use
Login with URL + key. As Admin: create tournament → division (set **Courts** + groups) →
register players (or bulk-edit sheet) → assign Placement slots → (optional) adjust
elimination seeding → set courts. Edit role enters results; View watches live.

---

## v0.3 — elimination structure (this release)

The big change. Analysis of the 9-division real workbook (`indivisual_test.xlsx`) showed the
elimination bracket is **standard tournament seeding**, not a fixed formula:

- **Placement winners (A₁..A_G) = top seeds 1..G**; **losers (B₁..B_G) = lower seeds G+1..2G**.
- Bracket size S = next power of 2 ≥ 2G; extra seeds are **BYEs that land on the top A seeds**,
  so some winners get a round-2 bye and all losers play round 1 (matches the real sheets:
  "the B slots are filled without exception, some A slots join them").
- Strong seeds never meet in round 1 (spreads favorites automatically).
- For G=14 (28 slots) this reproduces the reversed pairing A_i vs B_(G+1−i).

**Courts are a separate layer.** At division creation you set the number of courts.
Round-1 blocks are split contiguously across courts; a match keeps its court until blocks
merge (the final is central). The Elimination view has **court filter chips** so spectators
can see just their court.

**Seeding is editable (case Y).** Every round-1 slot links to `Group n Winner/Loser` (or BYE).
Default = standard seed; Admin can rewrite any slot in **Elimination seeding (round-1 links)**.
Editing is **locked once elimination results exist** (undo them to edit again).

## Full feature list

| Area | Behavior |
|---|---|
| Roles | View / Edit / Admin, auto-detected from key; tabs by permission; double-tap role badge to log out |
| View | Placement / Elimination / Match List tabs. Elimination = SVG bracket with connector lines (winner path in red), top=Red / bottom=White, zoom ±/Fit, court filter |
| Entry | Tap winner + M/K/D/T/H (max 2, same symbol ×2 allowed); Encho / Fusen (walkover → winner ○○); undo cascades downstream |
| Admin | Bulk-edit link to the spreadsheet; create tournament/division (courts + placement groups or bracket size); register players; slot assignment (players/BYE); elimination seeding editor; per-match court editor |
| Concurrency | LockService serializes writes; same-match re-entry is last-write-wins with downstream clear |
| Duplicates | Duplicate tournament / division / player rejected with an error |
| Mobile | Player names wrap (never truncated); team on a second line |

## Schema note (upgrading from v0.2)

`Matches` gained a `phase` column and round-1 now uses phase `elim1` for both placement and
non-placement brackets. If you have old data, clear `Matches` / `Entries` / `Divisions`
(keep headers, keep `PlayerMaster` / `Tournaments`) and recreate the division. A helper:

```javascript
function resetBrackets() {
  ['Matches','Entries','Divisions'].forEach(function(n){
    var sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(n);
    if(sh&&sh.getLastRow()>1) sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).clearContent();
  });
}
```

## Limits / next

- Placement must finish before its winners/losers appear in elimination (by design).
- Court split assumes contiguous blocks; uneven court counts put the remainder on leading courts.
- Phase 5: load the real division data and reconcile placements vs. the workbook.
- Phase 6: multiple divisions in parallel → team matches.
