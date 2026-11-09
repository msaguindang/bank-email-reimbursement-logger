// Run: node test.js  (checks the parser and the Members lookup against the sample emails)
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

// Code.gs uses top-level const, so load it into a context and read the functions back out.
const ctx = vm.createContext({});
vm.runInContext(
  fs.readFileSync(__dirname + '/Code.js', 'utf8') +
    '\nthis.parseTransfer = parseTransfer; this.parseWithdrawal = parseWithdrawal; this.toRow = toRow; this.isFromReimbursements = isFromReimbursements;' +
    ' this.isIncomingTransfer = isIncomingTransfer; this.modeOf = modeOf; this.lookupMember = lookupMember; this.splitWithdrawal = splitWithdrawal;' +
    ' this.roundCents = roundCents; this.formatPhp = formatPhp;',
  ctx
);

function email(rows) {
  return '<p>Dear CLIENT,</p><table>' + rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') + '</table><p>Important Reminders:</p>';
}

const members = [
  ['Ana Reyes', '', '09180000111'],
  ['Paolo Santos', '', '09190000222'],
  ['Paolo Santos', '', '09200000333'],
  ['Mario Dela Cruz', '', '100000000001'],
  ['Twin One', '', '09171110001'],
  ['Twin Two', '', '09171110002'],
];

// Oct 3 email: from the Reimbursements account (ends 001) -> must be recorded
const reimb = email([
  ['Confirmation Number', '1000000000001'],
  ['Transaction Date and Time', 'Saturday, Oct 03 2026; 03:04:07 PM (GMT +8)'],
  ['Transfer From', 'XXXX-XXXX-001 (Reimbursements)'],
  ['Transfer To', '09XXXXX0111'],
  ['Bank Name', 'GCash/G-Xchange'],
  ['Transfer Amount', 'PHP 750.00'],
  ['Transaction Ref No.', '100001'],
  ['Notes', 'cleaning'],
]);
const t = ctx.parseTransfer(reimb);
assert.strictEqual(ctx.isFromReimbursements(t), true);
assert.strictEqual(t.amount, 750);
assert.strictEqual(t.date.getMonth(), 9);
assert.strictEqual(t.date.getDate(), 3);

// Row layout: Date, Status, Debit, Credit, Name, Account Number, Mode, Description, Remarks, Category, Confirmation No.
const member = ctx.lookupMember(t.account, members);
assert.deepStrictEqual(JSON.parse(JSON.stringify(member)), { name: 'Ana Reyes', number: '09180000111' });
const row = ctx.toRow(t, member);
assert.strictEqual(row.length, 11);
assert.strictEqual(row[1], 'Done');
assert.strictEqual(row[3], '--');
assert.strictEqual(row[4], 'Ana Reyes');
assert.strictEqual(row[5], '09180000111');
assert.strictEqual(row[6], 'BPI to GCash');
assert.strictEqual(row[7], 'cleaning');
assert.strictEqual(row[8], 'Ref 100001');
assert.strictEqual(row[10], '1000000000001');

// No unique member: Name stays blank and the masked number is kept
const noMatch = ctx.toRow(t, null);
assert.strictEqual(noMatch[4], '');
assert.strictEqual(noMatch[5], '09XXXXX0111');

// Lookup rules: same person with two numbers still matches uniquely; two different people do not; wallet codes never match
assert.strictEqual(ctx.lookupMember('09XXXXX0222', members).name, 'Paolo Santos');
assert.strictEqual(ctx.lookupMember('0917XXX0001', members).name, 'Twin One');
assert.strictEqual(ctx.lookupMember('09171XXXXXX'.slice(0, 11), members), null); // matches both twins
assert.strictEqual(ctx.lookupMember('WLXXXXXX0EXAMPLE00', members), null);
assert.strictEqual(ctx.lookupMember('10XXXXX76602', members), null);

// Bank name -> mode, in the style of the existing rows
assert.strictEqual(ctx.modeOf('UnionBank'), 'BPI to Unionbank');
assert.strictEqual(ctx.modeOf('Metrobank'), 'BPI to Metrobank');
assert.strictEqual(ctx.modeOf(''), '--');

// Oct 31 email: incoming transfer TO the Reimbursements account (ends 001) -> recorded as Credit
const incomingReimb = email([
  ['Confirmation Number', '1000000000002'],
  ['Transaction Date and Time', 'Saturday, Oct 31 2026; 03:35:10 PM (GMT +8)'],
  ['Transfer From', 'XXXX-XXXX-002 (Checking)'],
  ['Transfer To', 'XXXX-XXXX-001 (Reimbursements)'],
  ['Amount', 'PHP 7,000.00'],
  ['Transaction Ref No.', '100002'],
  ['Notes', 'replenishment'],
]);
const tInc = ctx.parseTransfer(incomingReimb);
assert.notStrictEqual(tInc, null);
assert.strictEqual(tInc.amount, 7000);
assert.strictEqual(ctx.isFromReimbursements(tInc), true);
assert.strictEqual(ctx.isIncomingTransfer(tInc), true);

const incRow = ctx.toRow(tInc, null);
assert.strictEqual(incRow.length, 11);
assert.strictEqual(incRow[1], 'Done');
assert.strictEqual(incRow[2], '--');          // Debit: --
assert.strictEqual(incRow[3], 7000);          // Credit: 7000
assert.strictEqual(incRow[4], 'XXXX-XXXX-002'); // Sender
assert.strictEqual(incRow[6], 'BPI to BPI');  // Mode
assert.strictEqual(incRow[7], 'replenishment'); // Description
assert.strictEqual(incRow[9], 'Replenishment'); // Category
assert.strictEqual(incRow[10], '1000000000002'); // Confirmation

// Oct 8 email: from Express Savings (ends 003) -> parsed fine but must be skipped
const other = email([
  ['Confirmation Number', '1000000000003'],
  ['Transaction Date and Time', 'Thursday, Oct 08 2026; 03:11:15 PM (GMT +8)'],
  ['Transfer From', 'XXXX-XXXX-003 (Express Savings)'],
  ['Transfer To', 'WLXXXXXX0EXAMPLE00'],
  ['Bank Name', 'GCash/G-Xchange'],
  ['Transfer Amount', 'PHP 320.00'],
  ['Transaction Ref No.', '100003'],
  ['Notes', 'lunch'],
]);
assert.strictEqual(ctx.isFromReimbursements(ctx.parseTransfer(other)), false);

// Empty Notes must not pick up the reminders text
assert.strictEqual(ctx.parseTransfer(reimb.replace('cleaning', '')).description, '');

// Missing "Transfer From" (format change) -> rejected for review, not silently skipped
assert.strictEqual(ctx.parseTransfer(reimb.replace('Transfer From', 'Source')), null);

// Unrelated email is rejected, not written as a partial row
assert.strictEqual(ctx.parseTransfer('<p>Your statement is ready</p>'), null);

// Null/undefined/empty body defense
assert.strictEqual(ctx.parseTransfer(null), null);
assert.strictEqual(ctx.parseTransfer(undefined), null);
assert.strictEqual(ctx.parseTransfer(''), null);
assert.strictEqual(ctx.parseWithdrawal(null), null);
assert.strictEqual(ctx.parseWithdrawal(undefined), null);
assert.strictEqual(ctx.parseWithdrawal(''), null);
assert.strictEqual(ctx.modeOf(null), '--');
assert.strictEqual(ctx.modeOf(undefined), '--');

// --- Tests for ATM Cash Withdrawal Parsing ---

// 1. Table format BPI ATM withdrawal email
const wdEmailTable = email([
  ['Transaction Date and Time', 'Tuesday, Oct 27 2026; 10:15:30 AM (GMT +8)'],
  ['Account Number', 'XXXX-XXXX-001'],
  ['Amount Withdrawn', 'PHP 9,000.00'],
  ['ATM Location', 'BPI SAMPLE ST ATM 1'],
  ['Confirmation Number', 'WD-100000001'],
]);
const parsedWd = ctx.parseWithdrawal(wdEmailTable);
assert.notStrictEqual(parsedWd, null);
assert.strictEqual(parsedWd.amount, 9000);
assert.strictEqual(parsedWd.account, 'XXXX-XXXX-001');
assert.strictEqual(parsedWd.ref, 'WD-100000001');
assert.strictEqual(parsedWd.location, 'BPI SAMPLE ST ATM 1');
assert.strictEqual(ctx.isFromReimbursements(parsedWd), true);

// 2. Narrative format BPI ATM withdrawal email
const wdEmailNarrative = `
  <p>Dear CLIENT,</p>
  <p>Please be advised that an ATM cash withdrawal of PHP 5,000.00 was made from your account ending in 001 on Oct 28 2026.</p>
  <p>Trace / Ref: 100004.</p>
`;
const parsedWdNarrative = ctx.parseWithdrawal(wdEmailNarrative);
assert.notStrictEqual(parsedWdNarrative, null);
assert.strictEqual(parsedWdNarrative.amount, 5000);
assert.strictEqual(ctx.isFromReimbursements(parsedWdNarrative), true);

// 3. ATM withdrawal from non-reimbursement account (ends 003) -> detected, but isFromReimbursements is false
const wdOtherAccount = email([
  ['Transaction Date and Time', 'Tuesday, Oct 27 2026; 10:15:30 AM (GMT +8)'],
  ['Account Number', 'XXXX-XXXX-003'],
  ['Amount Withdrawn', 'PHP 3,000.00'],
  ['Confirmation Number', 'WD-999'],
]);
const parsedOtherWd = ctx.parseWithdrawal(wdOtherAccount);
assert.notStrictEqual(parsedOtherWd, null);
assert.strictEqual(ctx.isFromReimbursements(parsedOtherWd), false);

// --- Tests for ATM Cash Withdrawal & Deposit Box Handling (Option A) ---

// 1. Surplus case: 9000 withdrawn for 8354.25 receipt -> 645.75 change to Deposit Box
const surplus = ctx.splitWithdrawal(9000, 8354.25, 'Jane Cruz', 'Office supplies', 'Supplies', '2026-03-14');
assert.strictEqual(surplus.atmAmount, 9000);
assert.strictEqual(surplus.receiptAmount, 8354.25);
assert.strictEqual(surplus.change, 645.75);
assert.strictEqual(surplus.pocketSupplement, 0);
assert.strictEqual(surplus.mainRows.length, 2);

// Main row 1: Jane's receipt
const r1 = surplus.mainRows[0];
assert.strictEqual(r1[1], 'Done');
assert.strictEqual(r1[2], 8354.25);
assert.strictEqual(r1[4], 'Jane Cruz');
assert.strictEqual(r1[6], 'BPI to Cash');
assert.strictEqual(r1[7], 'Office supplies');

// Main row 2: Deposit Box change
const r2 = surplus.mainRows[1];
assert.strictEqual(r2[1], 'Done');
assert.strictEqual(r2[2], 645.75);
assert.strictEqual(r2[4], 'Deposit Box');
assert.strictEqual(r2[6], 'ATM Change to Box');

// Sum of debits on main sheet matches ATM withdrawal exactly
assert.strictEqual(r1[2] + r2[2], 9000);

// Deposit Box tab inflow entry
assert.notStrictEqual(surplus.boxRow, null);
assert.strictEqual(surplus.boxRow.inflow, 645.75);
assert.strictEqual(surplus.boxRow.outflow, 0);

// 2. Exact case: 1000 withdrawn for 1000 receipt -> exactly 1 row, 0 change
const exact = ctx.splitWithdrawal(1000, 1000, 'Ana Reyes', 'Cleaning', 'Labor', '2026-03-20');
assert.strictEqual(exact.atmAmount, 1000);
assert.strictEqual(exact.receiptAmount, 1000);
assert.strictEqual(exact.change, 0);
assert.strictEqual(exact.pocketSupplement, 0);
assert.strictEqual(exact.mainRows.length, 1);
assert.strictEqual(exact.mainRows[0][2], 1000);
assert.strictEqual(exact.boxRow, null);

// 3. Lack case: 4000 withdrawn for 4100 receipt -> 100 personal pocket supplement
const lack = ctx.splitWithdrawal(4000, 4100, 'Jane Cruz', 'Office supplies', 'Supplies', '2026-03-25');
assert.strictEqual(lack.atmAmount, 4000);
assert.strictEqual(lack.receiptAmount, 4100);
assert.strictEqual(lack.change, 0);
assert.strictEqual(lack.pocketSupplement, 100);
assert.strictEqual(lack.mainRows.length, 2);
assert.strictEqual(lack.mainRows[0][2], 4000); // 4000 cash from ATM
assert.strictEqual(lack.mainRows[0][4], 'Jane Cruz');
assert.strictEqual(lack.mainRows[1][1], 'Needs Review'); // 100 pending personal transfer
assert.strictEqual(lack.mainRows[1][2], 100);
assert.strictEqual(lack.mainRows[1][4], 'Treasurer');
assert.strictEqual(lack.boxRow, null);

// 4. Invalid input handling
assert.throws(() => ctx.splitWithdrawal(0, 1000, 'Test'), /ATM withdrawal amount must be greater than 0/);
assert.throws(() => ctx.splitWithdrawal(1000, 0, 'Test'), /Receipt \/ reimbursement amount must be greater than 0/);

console.log('ok');
