// Records BPI InstaPay transfer emails into the reimbursement sheet.
// Runs as the Gmail account that receives the BPI emails; the sheet is shared with it (Editor).

// The spreadsheet ID lives in Script Properties (key SHEET_ID), not in source.
function getSheetId() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Set the SHEET_ID script property to your spreadsheet ID');
  return id;
}
const TAB_NAME = '2026';
const MEMBERS_TAB = 'Members';
const DEPOSIT_BOX_TAB = 'Deposit Box';
const WITHDRAWALS_TAB = 'Withdrawals';
const SENDER = 'onlinebanking@bpi.com.ph';
const ACCOUNT_SUFFIX = '001'; // last digits of the tracked account (example value)
const FROM_ACCOUNT = 'XXXX-XXXX-' + ACCOUNT_SUFFIX; // only this account's transactions are recorded
const OWNER_NAME = 'Treasurer'; // who is credited when a withdrawal falls short and cash is covered personally
const STATUS = 'Done';
const LOOKBACK_DAYS = 14; // keep the trigger running more often than this
const REVIEW_LABEL = 'needs-review';
const CONF_COL = 11; // column K
// Columns: Date, Status, Debit, Credit, Name, Account Number, Mode of Reimbursement, Description, Remarks, Category, Confirmation No.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Turns the email HTML (or plain text) into { label: value } using the transaction table rows.
function toFields(body) {
  if (!body || typeof body !== 'string') return {};
  const text = body
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<\/tr>|<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  const fields = {};
  for (const line of text.split('\n')) {
    const [label, ...rest] = line.split('\t');
    if (rest.length === 0) continue;
    fields[label.trim().toLowerCase()] = rest.join(' ').trim();
  }
  return fields;
}

// Returns a row object, or null if the email is not a recognizable transfer.
function parseTransfer(body) {
  if (!body || typeof body !== 'string') return null;
  const f = toFields(body);
  const amountStr = f['transfer amount'] || f['amount'] || '';
  const amount = Number(amountStr.replace(/[^0-9.]/g, ''));
  const dateMatch = (f['transaction date and time'] || '').match(/([A-Za-z]{3})[a-z]* (\d{1,2}) (\d{4})/);
  const month = dateMatch ? MONTHS.indexOf(dateMatch[1].toLowerCase()) : -1;
  const confirmation = f['confirmation number'];
  const from = f['transfer from'];
  const to = f['transfer to'] || '';
  if (!(amount > 0) || month < 0 || !confirmation || !from) return null;
  return {
    from: from,
    to: to,
    date: new Date(Number(dateMatch[3]), month, Number(dateMatch[2])),
    amount: amount,
    account: to,
    bank: f['bank name'] || '',
    description: f['notes'] || '',
    ref: f['transaction ref no.'] || '',
    confirmation: confirmation,
  };
}

// Returns a withdrawal object, or null if the email is not a recognizable cash withdrawal.
function parseWithdrawal(body) {
  if (!body || typeof body !== 'string') return null;
  const f = toFields(body);
  const amountStr = f['amount withdrawn'] || f['transaction amount'] || f['withdrawal amount'] || f['amount'] || '';
  const amount = Number(amountStr.replace(/[^0-9.]/g, ''));
  const dateStr = f['transaction date and time'] || f['date and time'] || f['date'] || '';
  const dateMatch = dateStr.match(/([A-Za-z]{3})[a-z]* (\d{1,2}) (\d{4})/);
  const month = dateMatch ? MONTHS.indexOf(dateMatch[1].toLowerCase()) : -1;
  const confirmation = f['confirmation number'] || f['transaction ref no.'] || f['approval code'] || f['auth code'] || f['reference number'] || '';
  const from = f['account number'] || f['from account'] || f['transfer from'] || f['account'] || '';
  const location = f['atm location'] || f['location'] || f['terminal'] || f['channel'] || 'BPI ATM';

  if (!(amount > 0) || month < 0 || !confirmation || !from) {
    return parseWithdrawalRegex(body);
  }

  return {
    from: from,
    date: new Date(Number(dateMatch[3]), month, Number(dateMatch[2])),
    amount: amount,
    account: from,
    location: location,
    ref: confirmation,
    confirmation: confirmation,
    isWithdrawal: true,
  };
}

function parseWithdrawalRegex(body) {
  if (!body || typeof body !== 'string') return null;
  const clean = body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  if (!/withdraw|atm/i.test(clean)) return null;

  const amtMatch = clean.match(/(?:PHP|PHP\.|P)\s*([0-9,]+\.[0-9]{2})/i) || clean.match(/(?:amount|withdrawn)[^\d]*([0-9,]+\.[0-9]{2})/i);
  if (!amtMatch) return null;
  const amount = Number(amtMatch[1].replace(/,/g, ''));

  const dateMatch = clean.match(/([A-Za-z]{3})[a-z]* (\d{1,2})[,\s]+(\d{4})/);
  const month = dateMatch ? MONTHS.indexOf(dateMatch[1].toLowerCase()) : -1;
  if (!(amount > 0) || month < 0) return null;

  const acctMatch = clean.match(/(?:account|ending in)[^\w]*([0-9X]{4}-[0-9X]{4}-[0-9X]{3,4}|[0-9X]{3,4})/i);
  const from = acctMatch ? acctMatch[1] : '';

  const refMatch = clean.match(/(?:ref|confirmation|approval|trace)[^\w]*([0-9A-Za-z]+)/i);
  const confirmation = refMatch ? refMatch[1] : ('WD-' + Date.now());

  return {
    from: from,
    date: new Date(Number(dateMatch[3]), month, Number(dateMatch[2])),
    amount: amount,
    account: from,
    location: 'BPI ATM',
    ref: confirmation,
    confirmation: confirmation,
    isWithdrawal: true,
  };
}

function isReimbursementsTransaction(t) {
  if (!t) return false;
  if (t.isWithdrawal) {
    const acct = t.account || t.from || '';
    return acct.indexOf(FROM_ACCOUNT) !== -1 || acct.indexOf(ACCOUNT_SUFFIX) !== -1;
  }
  const fromReimb = t.from && (t.from.indexOf(FROM_ACCOUNT) !== -1 || t.from.indexOf(ACCOUNT_SUFFIX) !== -1);
  const toReimb = (t.to && (t.to.indexOf(FROM_ACCOUNT) !== -1 || t.to.indexOf(ACCOUNT_SUFFIX) !== -1)) ||
                  (t.account && (t.account.indexOf(FROM_ACCOUNT) !== -1 || t.account.indexOf(ACCOUNT_SUFFIX) !== -1));
  return Boolean(fromReimb || toReimb);
}

function isFromReimbursements(t) {
  return isReimbursementsTransaction(t);
}

function isIncomingTransfer(t) {
  if (!t) return false;
  const to = t.to || t.account || '';
  return to.indexOf(FROM_ACCOUNT) !== -1 || to.indexOf(ACCOUNT_SUFFIX) !== -1;
}

// "GCash/G-Xchange" -> "BPI to GCash", "UnionBank" -> "BPI to Unionbank" (matches the existing rows)
function modeOf(bank) {
  if (!bank || typeof bank !== 'string') return '--';
  const base = bank.split('/')[0].trim().replace(/^unionbank$/i, 'Unionbank');
  return base === '' ? '--' : 'BPI to ' + base;
}

// members: [[name, alias, number], ...]. The email masks the number ("09XXXXX0849"), so X matches any digit.
// Returns { name, number } when exactly one member name fits, otherwise null.
function lookupMember(masked, members) {
  if (!/^[0-9X]+$/i.test(masked)) return null;
  const pattern = new RegExp('^' + masked.toUpperCase().replace(/X/g, '\\d') + '$');
  const hits = members.filter(function (m) { return pattern.test(String(m[2]).trim()); });
  const names = hits.map(function (m) { return m[0]; }).filter(function (n, i, all) { return all.indexOf(n) === i; });
  return names.length === 1 ? { name: names[0], number: String(hits[0][2]).trim() } : null;
}

function toRow(t, member) {
  if (isIncomingTransfer(t)) {
    const senderDisplay = member ? member.name : (t.from ? t.from.replace(/\s*\([^\)]*\)/g, '').trim() : 'Replenishment');
    return [
      t.date,
      STATUS,
      '--',
      t.amount,
      senderDisplay,
      t.from || '--',
      t.bank ? modeOf(t.bank) : 'BPI to BPI',
      t.description || 'Fund replenishment',
      t.ref ? ('Ref ' + t.ref) : '',
      'Replenishment',
      t.confirmation,
    ];
  }
  return [
    t.date, STATUS, t.amount, '--',
    member ? member.name : '',
    member ? member.number : t.account,
    modeOf(t.bank), t.description,
    'Ref ' + t.ref, '', t.confirmation,
  ];
}

// Writes one row with Date shown as "October 8, 2026" and Account Number kept as plain text.
function appendTransfer(sheet, row) {
  const r = sheet.getLastRow() + 1;
  sheet.getRange(r, 1).setNumberFormat('MMMM d, yyyy'); // A: Date
  sheet.getRange(r, 6).setNumberFormat('@');            // F: Account Number
  sheet.getRange(r, 1, 1, row.length).setValues([row]);
}

// --- ATM Cash Withdrawal & Dedicated Sheet Handling ---

function roundCents(n) {
  return Math.round(Number(n) * 100) / 100;
}

function formatPhp(amount) {
  return '₱' + Number(amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Ensures the dedicated "Withdrawals" worksheet exists.
function getOrCreateWithdrawalsSheet(book) {
  let sheet = book.getSheetByName(WITHDRAWALS_TAB);
  if (!sheet) {
    sheet = book.insertSheet(WITHDRAWALS_TAB);
    sheet.appendRow([
      'Date', 'Status', 'ATM Amount', 'Recipient Name', 'Receipt Amount',
      'Deposit Box Change (+)', 'Personal Supplement (-)', 'Description / Purpose',
      'Account', 'Confirmation / Ref', 'Reconciled Date'
    ]);
    sheet.getRange(1, 1, 1, 11).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Appends an un-reconciled withdrawal row highlighted in red.
function appendWithdrawalStaging(book, w) {
  const sheet = getOrCreateWithdrawalsSheet(book);
  const r = sheet.getLastRow() + 1;
  sheet.getRange(r, 1).setNumberFormat('MMMM d, yyyy');
  sheet.getRange(r, 3).setNumberFormat('₱#,##0.00');
  sheet.getRange(r, 5).setNumberFormat('₱#,##0.00');
  sheet.getRange(r, 6).setNumberFormat('₱#,##0.00');
  sheet.getRange(r, 7).setNumberFormat('₱#,##0.00');
  sheet.getRange(r, 9).setNumberFormat('@');
  sheet.getRange(r, 10).setNumberFormat('@');
  sheet.getRange(r, 11).setNumberFormat('MMMM d, yyyy');

  sheet.getRange(r, 1, 1, 11).setValues([[
    w.date,
    'To be reconciled',
    w.amount,
    '',
    '',
    '',
    '',
    'Awaiting receipt & recipient (' + (w.location || 'BPI ATM') + ')',
    w.account,
    w.confirmation,
    ''
  ]]);

  // Soft red highlight to catch attention
  sheet.getRange(r, 1, 1, 11).setBackground('#fce8e6');
  sheet.getRange(r, 2).setFontColor('#c5221f').setFontWeight('bold');
}

// Calculates the split and prepares the rows for both the main Reimbursements sheet and the Deposit Box.
function splitWithdrawal(atmAmount, receiptAmount, recipientName, description, category, dateInput) {
  const atm = roundCents(atmAmount);
  const receipt = roundCents(receiptAmount);
  const date = dateInput ? new Date(dateInput) : new Date();
  const desc = description || '';
  const cat = category || '';

  if (!(atm > 0)) throw new Error('ATM withdrawal amount must be greater than 0');
  if (!(receipt > 0)) throw new Error('Receipt / reimbursement amount must be greater than 0');

  const mainRows = [];
  let boxRow = null;
  let pocketSupplement = 0;

  if (atm >= receipt) {
    // Case 1: Surplus or Exact.
    mainRows.push([
      date, STATUS, receipt, '--',
      recipientName, '--',
      'BPI to Cash', desc,
      'ATM Withdrawal (' + formatPhp(atm) + ')', cat, '',
    ]);

    const change = roundCents(atm - receipt);
    if (change > 0) {
      mainRows.push([
        date, STATUS, change, '--',
        'Deposit Box', '--',
        'ATM Change to Box', 'Change from ' + recipientName + ' (' + formatPhp(receipt) + ')',
        'Cash in Box', cat, '',
      ]);

      boxRow = {
        date: date,
        inflow: change,
        outflow: 0,
        source: 'ATM Withdrawal (' + formatPhp(atm) + ')',
        purpose: 'Change from ' + recipientName + ' reimbursement',
        remarks: desc,
      };
    }
  } else {
    // Case 2: Lack (Pocket Cash Supplement).
    pocketSupplement = roundCents(receipt - atm);
    mainRows.push([
      date, STATUS, atm, '--',
      recipientName, '--',
      'BPI to Cash', desc + ' (' + formatPhp(pocketSupplement) + ' supplemented from pocket cash)',
      'ATM Withdrawal (' + formatPhp(atm) + ')', cat, '',
    ]);

    mainRows.push([
      date, 'Needs Review', pocketSupplement, '--',
      OWNER_NAME, '--',
      'BPI to BPI', 'Supplement for ' + recipientName + ' reimbursement (' + desc + ')',
      'Pending personal transfer', cat, '',
    ]);
  }

  return {
    atmAmount: atm,
    receiptAmount: receipt,
    change: atm >= receipt ? roundCents(atm - receipt) : 0,
    pocketSupplement: pocketSupplement,
    mainRows: mainRows,
    boxRow: boxRow,
  };
}

// Ensures the "Deposit Box" worksheet exists with the proper columns.
function getOrCreateDepositBoxSheet(book) {
  let boxSheet = book.getSheetByName(DEPOSIT_BOX_TAB);
  if (!boxSheet) {
    boxSheet = book.insertSheet(DEPOSIT_BOX_TAB);
    boxSheet.appendRow([
      'Date', 'Status', 'Inflow (+)', 'Outflow (-)', 'Running Balance', 'Source / Recipient', 'Purpose', 'Remarks'
    ]);
    boxSheet.getRange(1, 1, 1, 8).setFontWeight('bold');
    boxSheet.setFrozenRows(1);
  }
  return boxSheet;
}

// Reconciles a staged withdrawal row from the Withdrawals tab into 2026 and Deposit Box.
function reconcileWithdrawalRow(book, rowNum, receiptAmount, recipientName, description, category) {
  const wdSheet = getOrCreateWithdrawalsSheet(book);
  if (rowNum < 2 || rowNum > wdSheet.getLastRow()) throw new Error('Invalid withdrawal row: ' + rowNum);

  const rowValues = wdSheet.getRange(rowNum, 1, 1, 11).getValues()[0];
  const date = rowValues[0] instanceof Date ? rowValues[0] : new Date();
  const currentStatus = String(rowValues[1]);
  const atmAmount = Number(rowValues[2]);
  const confirmation = String(rowValues[9]);

  if (!(atmAmount > 0)) throw new Error('Selected row does not have a valid ATM withdrawal amount');
  if (currentStatus === 'Reconciled') throw new Error('This row has already been reconciled on ' + rowValues[10]);

  const split = splitWithdrawal(atmAmount, receiptAmount, recipientName, description, category, date);

  // 1. Append rows to main 2026 tab
  const mainSheet = book.getSheetByName(TAB_NAME);
  if (!mainSheet) throw new Error('Tab not found: ' + TAB_NAME);
  for (const mainRow of split.mainRows) {
    if (confirmation) mainRow[10] = confirmation;
    appendTransfer(mainSheet, mainRow);
  }

  // 2. Append to Deposit Box tab if change
  if (split.boxRow) {
    const boxSheet = getOrCreateDepositBoxSheet(book);
    const lastRow = boxSheet.getLastRow();
    const balanceFormula = lastRow > 1
      ? '=E' + lastRow + ' + C' + (lastRow + 1) + ' - D' + (lastRow + 1)
      : '=C2 - D2';

    const newRow = lastRow + 1;
    boxSheet.getRange(newRow, 1).setNumberFormat('MMMM d, yyyy');
    boxSheet.getRange(newRow, 3).setNumberFormat('₱#,##0.00');
    boxSheet.getRange(newRow, 4).setNumberFormat('₱#,##0.00');
    boxSheet.getRange(newRow, 5).setNumberFormat('₱#,##0.00');
    boxSheet.getRange(newRow, 1, 1, 8).setValues([[
      split.boxRow.date,
      STATUS,
      split.boxRow.inflow,
      0,
      balanceFormula,
      split.boxRow.source,
      split.boxRow.purpose,
      split.boxRow.remarks,
    ]]);
  }

  // 3. Mark the row on Withdrawals tab as Reconciled
  wdSheet.getRange(rowNum, 2).setValue('Reconciled').setFontColor('#137333').setFontWeight('bold');
  wdSheet.getRange(rowNum, 4).setValue(recipientName);
  wdSheet.getRange(rowNum, 5).setValue(split.receiptAmount);
  wdSheet.getRange(rowNum, 6).setValue(split.change > 0 ? split.change : 0);
  wdSheet.getRange(rowNum, 7).setValue(split.pocketSupplement > 0 ? split.pocketSupplement : 0);
  wdSheet.getRange(rowNum, 8).setValue(description || ('Reconciled: ' + recipientName));
  wdSheet.getRange(rowNum, 11).setValue(new Date());

  // Clear red background and set soft green
  wdSheet.getRange(rowNum, 1, 1, 11).setBackground('#e6f4ea');

  return split;
}

// Records a withdrawal entry directly into both the main tab, Withdrawals tab, and Deposit Box tab.
function recordCashWithdrawalEntry(atmAmount, receiptAmount, recipientName, description, category, dateInput) {
  const book = SpreadsheetApp.openById(getSheetId());
  const split = splitWithdrawal(atmAmount, receiptAmount, recipientName, description, category, dateInput);

  // 1. Append main rows with formatting
  const sheet = book.getSheetByName(TAB_NAME);
  if (!sheet) throw new Error('Tab not found: ' + TAB_NAME);
  for (const row of split.mainRows) {
    appendTransfer(sheet, row);
  }

  // 2. Append to Deposit Box tab if change was generated
  if (split.boxRow) {
    const boxSheet = getOrCreateDepositBoxSheet(book);
    const lastRow = boxSheet.getLastRow();
    const balanceFormula = lastRow > 1
      ? '=E' + lastRow + ' + C' + (lastRow + 1) + ' - D' + (lastRow + 1)
      : '=C2 - D2';

    const newRow = lastRow + 1;
    boxSheet.getRange(newRow, 1).setNumberFormat('MMMM d, yyyy');
    boxSheet.getRange(newRow, 3).setNumberFormat('₱#,##0.00');
    boxSheet.getRange(newRow, 4).setNumberFormat('₱#,##0.00');
    boxSheet.getRange(newRow, 5).setNumberFormat('₱#,##0.00');
    boxSheet.getRange(newRow, 1, 1, 8).setValues([[
      split.boxRow.date,
      STATUS,
      split.boxRow.inflow,
      0,
      balanceFormula,
      split.boxRow.source,
      split.boxRow.purpose,
      split.boxRow.remarks,
    ]]);
  }

  // 3. Log to Withdrawals tab as already reconciled
  const wdSheet = getOrCreateWithdrawalsSheet(book);
  const r = wdSheet.getLastRow() + 1;
  wdSheet.getRange(r, 1).setNumberFormat('MMMM d, yyyy');
  wdSheet.getRange(r, 3).setNumberFormat('₱#,##0.00');
  wdSheet.getRange(r, 5).setNumberFormat('₱#,##0.00');
  wdSheet.getRange(r, 6).setNumberFormat('₱#,##0.00');
  wdSheet.getRange(r, 7).setNumberFormat('₱#,##0.00');
  wdSheet.getRange(r, 11).setNumberFormat('MMMM d, yyyy');
  wdSheet.getRange(r, 1, 1, 11).setValues([[
    dateInput ? new Date(dateInput) : new Date(),
    'Reconciled',
    split.atmAmount,
    recipientName,
    split.receiptAmount,
    split.change > 0 ? split.change : 0,
    split.pocketSupplement > 0 ? split.pocketSupplement : 0,
    description,
    FROM_ACCOUNT,
    'Manual Entry',
    new Date()
  ]]);
  wdSheet.getRange(r, 1, 1, 11).setBackground('#e6f4ea');
  wdSheet.getRange(r, 2).setFontColor('#137333').setFontWeight('bold');

  return split;
}

function recordBpiTransfers() {
  const book = SpreadsheetApp.openById(getSheetId());
  const sheet = book.getSheetByName(TAB_NAME);
  if (!sheet) throw new Error('Tab not found: ' + TAB_NAME);
  const membersSheet = book.getSheetByName(MEMBERS_TAB);
  if (!membersSheet) throw new Error('Tab not found: ' + MEMBERS_TAB);
  const members = membersSheet.getLastRow() > 1 ? membersSheet.getRange(2, 1, membersSheet.getLastRow() - 1, 3).getValues() : [];
  const review = GmailApp.getUserLabelByName(REVIEW_LABEL) || GmailApp.createLabel(REVIEW_LABEL);
  const lastRow = sheet.getLastRow();
  const seen = new Set(lastRow > 0 ? sheet.getRange(1, CONF_COL, lastRow, 1).getValues().flat().map(String) : []);

  // Track seen confirmations in Withdrawals tab
  const wdSheet = getOrCreateWithdrawalsSheet(book);
  const lastWdRow = wdSheet.getLastRow();
  const seenWd = new Set(lastWdRow > 1 ? wdSheet.getRange(2, 10, lastWdRow - 1, 1).getValues().flat().map(String) : []);

  const cutoff = Date.now() - LOOKBACK_DAYS * 86400000;
  const threads = GmailApp.search('from:' + SENDER + ' newer_than:' + LOOKBACK_DAYS + 'd');

  for (const thread of threads.reverse()) {
    for (const msg of thread.getMessages()) {
      if (msg.getDate().getTime() < cutoff) continue;
      const body = msg.getBody() || msg.getPlainBody() || '';
      if (!body) continue;

      // 1. Funds / InstaPay transfer
      const t = parseTransfer(body);
      if (t) {
        if (!isFromReimbursements(t) || seen.has(t.confirmation)) continue;
        appendTransfer(sheet, toRow(t, lookupMember(t.account, members)));
        seen.add(t.confirmation);
        continue;
      }

      // 2. ATM Cash Withdrawal
      const w = parseWithdrawal(body);
      if (w) {
        if (!isFromReimbursements(w) || seenWd.has(w.confirmation)) continue;
        appendWithdrawalStaging(book, w);
        seenWd.add(w.confirmation);
        continue;
      }

      // 3. Not recognized: add review label
      thread.addLabel(review);
    }
  }
}

// Custom UI menu in Google Sheets
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Reimbursements')
    .addItem('Reconcile Cash Withdrawal...', 'promptReconcileWithdrawal')
    .addItem('Record New Cash Withdrawal & Split...', 'promptCashWithdrawal')
    .addItem('Log Check Deposit Replenishment...', 'promptCheckDeposit')
    .addSeparator()
    .addItem('Check BPI Emails Now', 'recordBpiTransfers')
    .addItem('Enable / Reset Automatic 10-min Scan', 'setupAutomaticTrigger')
    .addToUi();
}

// Installs or refreshes the 10-minute time-based trigger for background email scanning.
function setupAutomaticTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'recordBpiTransfers') {
      ScriptApp.deleteTrigger(t);
    }
  }
  ScriptApp.newTrigger('recordBpiTransfers')
    .timeBased()
    .everyMinutes(10)
    .create();

  try {
    SpreadsheetApp.getUi().alert('Trigger Configured', 'Automatic 10-minute BPI email scan is now active for this spreadsheet.', SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    // Handled silently if called outside UI context
  }
}

// Interactive prompt dialog to reconcile a pending withdrawal from Withdrawals tab
function promptReconcileWithdrawal() {
  const ui = SpreadsheetApp.getUi();
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const wdSheet = getOrCreateWithdrawalsSheet(book);
  const lastRow = wdSheet.getLastRow();

  if (lastRow < 2) {
    ui.alert('Reconcile Withdrawal', 'No cash withdrawals found on the "' + WITHDRAWALS_TAB + '" sheet.', ui.ButtonSet.OK);
    return;
  }

  // Find target row: active row if on Withdrawals sheet, otherwise first "To be reconciled"
  let targetRow = -1;
  const activeSheet = book.getActiveSheet();
  if (activeSheet.getName() === WITHDRAWALS_TAB) {
    const selRow = activeSheet.getActiveCell().getRow();
    if (selRow >= 2 && selRow <= lastRow) {
      targetRow = selRow;
    }
  }

  if (targetRow === -1) {
    const statuses = wdSheet.getRange(2, 2, lastRow - 1, 1).getValues();
    for (let i = 0; i < statuses.length; i++) {
      if (statuses[i][0] === 'To be reconciled') {
        targetRow = i + 2;
        break;
      }
    }
  }

  if (targetRow === -1) {
    ui.alert('Reconcile Withdrawal', 'All recorded withdrawals are already reconciled! Nothing pending.', ui.ButtonSet.OK);
    return;
  }

  const rowData = wdSheet.getRange(targetRow, 1, 1, 10).getValues()[0];
  const dateStr = rowData[0] instanceof Date ? rowData[0].toLocaleDateString() : String(rowData[0]);
  const atmAmt = Number(rowData[2]);
  const prefillName = String(rowData[3] || '').trim();
  const prefillReceipt = Number(rowData[4]);
  const prefillDesc = String(rowData[7] || '').trim();

  // Seamless path: if user already typed Recipient Name (Col D) and Receipt Amount (Col E) directly in the sheet
  if (prefillName && prefillReceipt > 0) {
    const split = splitWithdrawal(atmAmt, prefillReceipt, prefillName, prefillDesc, 'Cash Reimbursement', rowData[0]);
    let summaryMsg = 'Reconcile row ' + targetRow + ' with entered values?\n\n' +
      '• Recipient: ' + prefillName + '\n' +
      '• Receipt: ' + formatPhp(prefillReceipt) + '\n';
    if (split.change > 0) {
      summaryMsg += '• Change to Deposit Box: ' + formatPhp(split.change) + '\n';
    } else if (split.pocketSupplement > 0) {
      summaryMsg += '• Personal supplement: ' + formatPhp(split.pocketSupplement) + '\n';
    }
    const confirmPrompt = ui.alert('Confirm Reconciliation', summaryMsg, ui.ButtonSet.OK_CANCEL);
    if (confirmPrompt !== ui.Button.OK) return;
    try {
      reconcileWithdrawalRow(book, targetRow, prefillReceipt, prefillName, prefillDesc, 'Cash Reimbursement');
      let msg = 'Withdrawal reconciled successfully!\n' +
        '• Row ' + targetRow + ' marked Reconciled on "' + WITHDRAWALS_TAB + '"\n' +
        '• Reimbursed to ' + prefillName + ': ' + formatPhp(split.receiptAmount) + ' (posted to ' + TAB_NAME + ')';
      if (split.change > 0) {
        msg += '\n• Deposit Box change: ' + formatPhp(split.change) + ' (credited to ' + DEPOSIT_BOX_TAB + ')';
      } else if (split.pocketSupplement > 0) {
        msg += '\n• Personal cash supplement: ' + formatPhp(split.pocketSupplement) + ' (advance noted on ' + TAB_NAME + ')';
      }
      ui.alert('Success', msg, ui.ButtonSet.OK);
      return;
    } catch (err) {
      ui.alert('Error', err.message, ui.ButtonSet.OK);
      return;
    }
  }

  const confirmPrompt = ui.alert(
    'Reconcile ATM Withdrawal',
    'Reconciling row ' + targetRow + ' on "' + WITHDRAWALS_TAB + '":\n' +
    '• Date: ' + dateStr + '\n' +
    '• ATM Amount: ' + formatPhp(atmAmt) + '\n\n' +
    'Click OK to proceed with entering receipt details.',
    ui.ButtonSet.OK_CANCEL
  );
  if (confirmPrompt !== ui.Button.OK) return;

  const namePrompt = ui.prompt('Reconcile Withdrawal', 'Enter Recipient Name (e.g. Jane Cruz):', ui.ButtonSet.OK_CANCEL);
  if (namePrompt.getSelectedButton() !== ui.Button.OK) return;
  const recipientName = namePrompt.getResponseText().trim();
  if (!recipientName) {
    ui.alert('Error', 'Recipient name cannot be blank.', ui.ButtonSet.OK);
    return;
  }

  const receiptPrompt = ui.prompt('Reconcile Withdrawal', 'Enter Exact Receipt / Reimbursement Amount (e.g. 8354.25):', ui.ButtonSet.OK_CANCEL);
  if (receiptPrompt.getSelectedButton() !== ui.Button.OK) return;
  const receiptAmount = Number(receiptPrompt.getResponseText().replace(/[^0-9.]/g, ''));

  const descPrompt = ui.prompt('Reconcile Withdrawal', 'Enter Description / Purpose (e.g. Office food and supplies):', ui.ButtonSet.OK_CANCEL);
  const description = descPrompt.getSelectedButton() === ui.Button.OK ? descPrompt.getResponseText().trim() : '';

  try {
    const result = reconcileWithdrawalRow(book, targetRow, receiptAmount, recipientName, description, 'Cash Reimbursement');
    let msg = 'Withdrawal reconciled successfully!\n' +
      '• Row ' + targetRow + ' marked Reconciled on "' + WITHDRAWALS_TAB + '"\n' +
      '• Reimbursed to ' + recipientName + ': ' + formatPhp(result.receiptAmount) + ' (posted to ' + TAB_NAME + ')';
    if (result.change > 0) {
      msg += '\n• Deposit Box change: ' + formatPhp(result.change) + ' (credited to ' + DEPOSIT_BOX_TAB + ')';
    } else if (result.pocketSupplement > 0) {
      msg += '\n• Personal cash supplement: ' + formatPhp(result.pocketSupplement) + ' (advance noted on ' + TAB_NAME + ')';
    }
    ui.alert('Success', msg, ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Error', err.message, ui.ButtonSet.OK);
  }
}

// Interactive prompt dialog to manually log a new withdrawal
function promptCashWithdrawal() {
  const ui = SpreadsheetApp.getUi();
  const atmPrompt = ui.prompt('Cash Withdrawal', 'Enter total ATM cash amount withdrawn (e.g. 9000):', ui.ButtonSet.OK_CANCEL);
  if (atmPrompt.getSelectedButton() !== ui.Button.OK) return;
  const atmAmount = Number(atmPrompt.getResponseText().replace(/[^0-9.]/g, ''));

  const namePrompt = ui.prompt('Cash Withdrawal', 'Enter Recipient Name (e.g. Jane Cruz):', ui.ButtonSet.OK_CANCEL);
  if (namePrompt.getSelectedButton() !== ui.Button.OK) return;
  const recipientName = namePrompt.getResponseText().trim();

  const receiptPrompt = ui.prompt('Cash Withdrawal', 'Enter Exact Receipt / Reimbursement Amount (e.g. 8354.25):', ui.ButtonSet.OK_CANCEL);
  if (receiptPrompt.getSelectedButton() !== ui.Button.OK) return;
  const receiptAmount = Number(receiptPrompt.getResponseText().replace(/[^0-9.]/g, ''));

  const descPrompt = ui.prompt('Cash Withdrawal', 'Enter Description / Notes (e.g. Office cleaning and food supplies):', ui.ButtonSet.OK_CANCEL);
  const description = descPrompt.getSelectedButton() === ui.Button.OK ? descPrompt.getResponseText().trim() : '';

  try {
    const result = recordCashWithdrawalEntry(atmAmount, receiptAmount, recipientName, description, 'Cash Reimbursement');
    let msg = 'Recorded successfully!\n- Reimbursement to ' + recipientName + ': ' + formatPhp(result.receiptAmount);
    if (result.change > 0) {
      msg += '\n- Deposit Box change added: ' + formatPhp(result.change);
    } else if (result.pocketSupplement > 0) {
      msg += '\n- Personal cash supplement noted: ' + formatPhp(result.pocketSupplement);
    }
    ui.alert('Withdrawal Recorded', msg, ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Error', err.message, ui.ButtonSet.OK);
  }
}

// Interactive prompt dialog to log a check deposit replenishment
function promptCheckDeposit() {
  const ui = SpreadsheetApp.getUi();
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName(TAB_NAME);
  if (!sheet) {
    ui.alert('Error', 'Tab not found: ' + TAB_NAME, ui.ButtonSet.OK);
    return;
  }

  const amtPrompt = ui.prompt('Log Check Deposit Replenishment', 'Enter Check Amount (e.g. 50000):', ui.ButtonSet.OK_CANCEL);
  if (amtPrompt.getSelectedButton() !== ui.Button.OK) return;
  const amount = Number(amtPrompt.getResponseText().replace(/[^0-9.]/g, ''));
  if (!(amount > 0)) {
    ui.alert('Error', 'Check amount must be greater than 0.', ui.ButtonSet.OK);
    return;
  }

  const descPrompt = ui.prompt('Log Check Deposit Replenishment', 'Enter Check Number & Details (e.g. Check #123456 - General Fund):', ui.ButtonSet.OK_CANCEL);
  if (descPrompt.getSelectedButton() !== ui.Button.OK) return;
  const desc = descPrompt.getResponseText().trim() || 'Check deposit replenishment';

  const checkRow = [
    new Date(),
    STATUS,
    '--',
    amount,
    'General Fund',
    'Check',
    'Check Deposit',
    desc,
    'Replenishment',
    'Replenishment',
    'CHK-' + Date.now().toString().slice(-6)
  ];

  appendTransfer(sheet, checkRow);
  ui.alert('Success', 'Check deposit of ' + formatPhp(amount) + ' recorded under Credit on "' + TAB_NAME + '"!', ui.ButtonSet.OK);
}
