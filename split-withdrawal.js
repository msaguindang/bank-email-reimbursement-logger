#!/usr/bin/env node
// CLI Helper: Calculates and formats cash withdrawals for the Reimbursements sheet and Deposit Box.
const fs = require('fs');
const readline = require('readline');
const vm = require('vm');

const ctx = vm.createContext({});
vm.runInContext(
  fs.readFileSync(__dirname + '/Code.js', 'utf8') +
    '\nthis.splitWithdrawal = splitWithdrawal; this.formatPhp = formatPhp;',
  ctx
);

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--atm') params.atm = Number(args[++i]);
    else if (args[i] === '--receipt') params.receipt = Number(args[++i]);
    else if (args[i] === '--name') params.name = args[++i];
    else if (args[i] === '--desc') params.desc = args[++i];
    else if (args[i] === '--date') params.date = args[++i];
    else if (args[i] === '--csv') params.csv = args[++i];
  }
  return params;
}

function formatDate(d) {
  const date = d ? new Date(d) : new Date();
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

async function promptUser() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  console.log('\n--- Cash Withdrawal & Split Calculator ---\n');
  const atmInput = await ask('Total ATM Amount Withdrawn (PHP, e.g. 9000): ');
  const nameInput = await ask('Recipient Name (default: Jane Cruz): ') || 'Jane Cruz';
  const receiptInput = await ask('Exact Receipt / Reimbursement Amount (PHP, e.g. 8354.25): ');
  const descInput = await ask('Description / Purpose: ');
  const dateInput = await ask('Date (YYYY-MM-DD or leave blank for today): ');
  rl.close();

  return {
    atm: Number(atmInput.replace(/[^0-9.]/g, '')),
    name: nameInput.trim(),
    receipt: Number(receiptInput.replace(/[^0-9.]/g, '')),
    desc: descInput.trim(),
    date: dateInput.trim() || undefined,
  };
}

async function main() {
  let params = parseArgs();
  if (!params.atm || !params.receipt) {
    params = await promptUser();
  }

  const result = ctx.splitWithdrawal(
    params.atm,
    params.receipt,
    params.name || 'Jane Cruz',
    params.desc || '',
    'Cash Reimbursement',
    params.date
  );

  console.log('\n========================================');
  console.log('       WITHDRAWAL SPLIT SUMMARY         ');
  console.log('========================================');
  console.log(`ATM Cash Withdrawn : ${ctx.formatPhp(result.atmAmount)}`);
  console.log(`Reimbursement Paid : ${ctx.formatPhp(result.receiptAmount)} to ${params.name || 'Jane Cruz'}`);

  if (result.change > 0) {
    console.log(`Surplus Change     : ${ctx.formatPhp(result.change)} -> INFLOW to Deposit Box`);
  } else if (result.pocketSupplement > 0) {
    console.log(`Pocket Supplement  : ${ctx.formatPhp(result.pocketSupplement)} -> Advance to be transferred back`);
  }
  console.log('----------------------------------------\n');

  console.log('--- Rows to append to Reimbursements Sheet ---');
  for (const row of result.mainRows) {
    console.log(`Date: "${formatDate(row[0])}" | Status: ${row[1]} | Debit: ${ctx.formatPhp(row[2])} | Credit: ${row[3]} | Name: ${row[4]} | Mode: ${row[6]} | Desc: ${row[7]} | Remarks: ${row[8]}`);
  }

  if (result.boxRow) {
    console.log('\n--- Row to append to Deposit Box Sheet ---');
    console.log(`Date: "${formatDate(result.boxRow.date)}" | Status: Done | Inflow: ${ctx.formatPhp(result.boxRow.inflow)} | Outflow: -- | Source: ${result.boxRow.source} | Purpose: ${result.boxRow.purpose}`);
  }

  // If local CSV target specified, append directly
  if (params.csv && fs.existsSync(params.csv)) {
    for (const r of result.mainRows) {
      const csvLine = `"${formatDate(r[0])}",${r[1]},"${ctx.formatPhp(r[2])}",${r[3]},${r[4]},${r[5]},${r[6]},"${r[7]}","${r[8]}",,\n`;
      fs.appendFileSync(params.csv, csvLine, 'utf8');
    }
    console.log(`\nSuccessfully appended ${result.mainRows.length} rows to ${params.csv}`);
  }
  console.log('\n========================================\n');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
