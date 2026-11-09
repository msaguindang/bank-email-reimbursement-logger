# Bank Email Reimbursement Logger

A Google Apps Script that turns bank notification emails into rows in a shared reimbursement spreadsheet, so a treasurer stops retyping them by hand.

```
bank email → Gmail → Apps Script parser → sheet row
                                         ├─ transfers  → main ledger (debit / credit)
                                         └─ ATM cash   → "Withdrawals" tab → reconcile → ledger + Deposit Box
```

## What it does

- **Parses transfer emails** (outgoing and incoming) and ATM withdrawal notices, in both table and narrative layouts.
- **Only records the tracked account.** Transfers from or to other accounts are parsed, then skipped.
- **De-duplicates** by confirmation number, so a 10-minute scan with a 14-day lookback never double-posts.
- **Matches recipients** from a Members tab. The bank masks mobile numbers (`09XXXXX0111`), so `X` matches any digit. A name is filled in only when exactly one member fits.
- **Splits cash withdrawals.** One ATM withdrawal becomes the reimbursement row plus any change into a Deposit Box ledger with a running balance. If the receipt is more than the cash withdrawn, the shortfall is logged as a personal supplement that needs review.
- **Fails loudly, not silently.** An unrecognized email gets a `needs-review` Gmail label instead of a half-filled row.
- **Sheet menu** for reconciling a withdrawal, entering one manually, logging a check deposit, scanning now, and installing the timer.

## Run the tests

```
node test.js
```

No dependencies. The tests load `Code.js` into a Node VM context and cover the parsers, the masked-number lookup, the split arithmetic (surplus, exact, shortfall), and bad or empty input. `node split-withdrawal.js --atm 9000 --receipt 8354.25 --name "Jane Cruz"` previews a split from the command line.

## Set up

1. Create a script **bound to the spreadsheet** (Extensions → Apps Script). A standalone script cannot add menus to a sheet.
2. Paste in `Code.js` and `appsscript.json`, or push them with [clasp](https://github.com/google/clasp).
3. Project Settings → Script Properties: add `SHEET_ID` with your spreadsheet's ID.
4. Edit the constants at the top of `Code.js` (`ACCOUNT_SUFFIX`, tab names, `SENDER`).
5. Reload the sheet, open the Reimbursements menu, and run *Enable / Reset Automatic 10-min Scan* once. Google asks for authorization the first time.

## Design notes

- **Container-bound script.** Menus need it. The scan trigger lives in the same project so there is one place to look.
- **Idempotent scan.** Safe to run any time, because posted confirmation numbers are the dedupe key.
- **Email format is the contract.** The parser reads labeled fields, with a regex fallback for narrative withdrawal notices. If the bank changes its layout, mail is labeled for review.

All names, numbers and account digits in the tests are invented.
