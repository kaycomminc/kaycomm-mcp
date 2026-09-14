#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const billing = JSON.parse(fs.readFileSync(path.join(__dirname, 'billing.json'), 'utf8'));

function generateBillingSheet(targetMonth) {
  const now = targetMonth ? new Date(targetMonth + '-01') : new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0);
  const daysInMonth = monthEnd.getDate();

  const monthName = monthStart.toLocaleString('en-US', { month: 'long' });
  const defaultDay = billing.settings.default_invoice_day || 1;
  const defaultInvoiceDate = new Date(year, month, defaultDay);
  const termsDays = parseInt((billing.settings.default_payment_terms || 'Net 15').replace(/\D/g, '')) || 15;
  const defaultDueDate = addDays(defaultInvoiceDate, termsDays);

  const rows = [];

  for (const [key, client] of Object.entries(billing.clients)) {
    if (!client.active) continue;
    if (!client.line_items || client.line_items.length === 0) continue;

    const { invoiceDate, dueDate } = getInvoiceDates(client, defaultInvoiceDate, defaultDueDate, year, month);

    if (client.billing_type === 'flighted') {
      const flightStart = new Date(client.flight_start);
      const flightEnd = new Date(client.flight_end);

      if (monthEnd < flightStart || monthStart > flightEnd) continue;

      const overlapStart = flightStart > monthStart ? flightStart : monthStart;
      const overlapEnd = flightEnd < monthEnd ? flightEnd : monthEnd;
      const overlapDays = Math.ceil((overlapEnd - overlapStart) / (1000 * 60 * 60 * 24)) + 1;
      const fraction = overlapDays / daysInMonth;
      const isPartialMonth = overlapDays < daysInMonth;

      for (const item of client.line_items) {
        const amount = item.prorate_partial
          ? Math.round(item.rate * fraction * 100) / 100
          : item.rate;

        const description = isPartialMonth && item.prorate_partial
          ? `${item.description} (${formatDate(overlapStart)} - ${formatDate(overlapEnd)}, ${overlapDays}/${daysInMonth} days)`
          : `${item.description} — ${monthName} ${year}`;

        rows.push({
          customer: client.customer,
          invoiceDate,
          dueDate,
          terms: billing.settings.default_payment_terms,
          item: item.product_service || '',
          description,
          quantity: item.quantity || 1,
          rate: amount,
          amount: amount * (item.quantity || 1),
          clientKey: key
        });
      }
    } else {
      for (const item of client.line_items) {
        const description = `${item.description} — ${monthName} ${year}`;
        rows.push({
          customer: client.customer,
          invoiceDate,
          dueDate,
          terms: billing.settings.default_payment_terms,
          item: item.product_service || '',
          description,
          quantity: item.quantity || 1,
          rate: item.rate,
          amount: item.rate * (item.quantity || 1),
          clientKey: key
        });
      }
    }
  }

  return { rows, monthName, year, daysInMonth };
}

function addDays(d, days) {
  const result = new Date(d);
  result.setDate(result.getDate() + days);
  return result;
}

function getInvoiceDates(client, defaultInvoiceDate, defaultDueDate, year, month) {
  if (client.invoice_day) {
    const invoiceDate = new Date(year, month, client.invoice_day);
    const termsDays = parseInt((billing.settings.default_payment_terms || 'Net 15').replace(/\D/g, '')) || 15;
    const dueDate = addDays(invoiceDate, termsDays);
    return { invoiceDate: formatDate(invoiceDate), dueDate: formatDate(dueDate) };
  }
  return { invoiceDate: formatDate(defaultInvoiceDate), dueDate: formatDate(defaultDueDate) };
}

function formatDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function toCSV(rows) {
  const headers = [
    '*InvoiceNo',
    '*Customer',
    '*InvoiceDate',
    '*DueDate',
    'Terms',
    'Location',
    'Memo',
    'Item(Product/Service)',
    'ItemDescription',
    'ItemQuantity',
    'ItemRate',
    '*ItemAmount',
    'Shipping address',
    'Ship via',
    'Shipping date',
    'Tracking no.',
    'Shipping Charge',
    'Service Date'
  ];

  const grouped = {};
  let invoiceNum = 1;
  for (const row of rows) {
    const groupKey = `${row.customer}||${row.invoiceDate}`;
    if (!grouped[groupKey]) {
      grouped[groupKey] = { invoiceNo: invoiceNum++, rows: [] };
    }
    grouped[groupKey].rows.push(row);
  }

  const csvRows = [headers.join(',')];
  for (const group of Object.values(grouped)) {
    group.rows.forEach((row, i) => {
      const prefix = billing.settings.invoice_prefix || '';
      csvRows.push([
        i === 0 ? `${prefix}${group.invoiceNo}` : `${prefix}${group.invoiceNo}`,
        i === 0 ? csvEscape(row.customer) : '',
        i === 0 ? row.invoiceDate : '',
        i === 0 ? row.dueDate : '',
        i === 0 ? row.terms : '',
        '',
        '',
        csvEscape(row.item),
        csvEscape(row.description),
        row.quantity,
        row.rate.toFixed(2),
        row.amount.toFixed(2),
        '', '', '', '', '', ''
      ].join(','));
    });
  }
  return csvRows.join('\n');
}

function csvEscape(val) {
  if (!val) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function printSummary(rows, monthName, year) {
  console.log(`\n=== Billing Summary: ${monthName} ${year} ===\n`);

  const byCustomer = {};
  for (const row of rows) {
    const key = `${row.customer} (${row.clientKey})`;
    if (!byCustomer[key]) byCustomer[key] = { items: [], total: 0 };
    byCustomer[key].items.push(row);
    byCustomer[key].total += row.amount;
  }

  let grandTotal = 0;
  for (const [customer, data] of Object.entries(byCustomer)) {
    console.log(`${customer}`);
    for (const item of data.items) {
      console.log(`  ${item.description}  $${item.amount.toFixed(2)}`);
    }
    console.log(`  Subtotal: $${data.total.toFixed(2)}\n`);
    grandTotal += data.total;
  }

  console.log(`Grand Total: $${grandTotal.toFixed(2)}`);
  console.log(`Total invoices: ${Object.keys(byCustomer).length}`);
}

const targetMonth = process.argv[2]; // e.g. "2026-09"
const { rows, monthName, year } = generateBillingSheet(targetMonth);

if (rows.length === 0) {
  console.log('No billable clients configured yet. Add line_items to billing.json first.');
  process.exit(0);
}

printSummary(rows, monthName, year);

const filename = `billing-${targetMonth || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`}.csv`;
const outPath = path.join(__dirname, filename);
fs.writeFileSync(outPath, toCSV(rows));
console.log(`\nCSV written to: ${outPath}`);
console.log('Review the summary above, then import into QuickBooks.');
