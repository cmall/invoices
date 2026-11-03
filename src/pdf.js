'use strict';
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const config = require('./config');
const settings = require('./settings');
const { formatMoney, formatDate, formatQuantity, formatRate, cleanText, displayUrl } = require('./util');

const GREY = '#6b7280';
const DARK = '#111827';
const RULE = '#d1d5db';

function publicUrl(doc) {
  return `${config.appUrl}/${doc.kind === 'invoice' ? 'i' : 'e'}/${doc.public_token}`;
}

// Creates a PDF with the business's paper size, fonts and colours, and draws the header
// (logo or name on the left, business details on the right).
function startPdf(s, title) {
  const accent = validColor(s.accent_color, '#2f5d8a');
  const heading = validColor(s.heading_color, accent);
  const F = s.invoice_font === 'classic' ? { regular: 'Times-Roman', bold: 'Times-Bold' } : { regular: 'Helvetica', bold: 'Helvetica-Bold' };
  const logoFit = { small: [120, 40], medium: [180, 60], large: [240, 90] }[s.logo_size] || [180, 60];
  const pdf = new PDFDocument({
    size: s.paper_size === 'A4' ? 'A4' : 'LETTER',
    margins: { top: 50, bottom: 60, left: 50, right: 50 },
    bufferPages: true,
    info: { Title: title, Author: s.business_name || '' },
  });
  const chunks = [];
  pdf.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });

  // Clean every string before it is drawn or measured, so stray \r (from addresses typed in a
  // browser) and other control characters never show up as odd glyphs.
  for (const fn of ['text', 'heightOfString', 'widthOfString']) {
    const orig = pdf[fn].bind(pdf);
    pdf[fn] = (t, ...rest) => orig(typeof t === 'string' ? cleanText(t) : t, ...rest);
  }

  const left = pdf.page.margins.left;
  const right = pdf.page.width - pdf.page.margins.right;
  const width = right - left;

  let headerBottom = 50;
  const logoPath = s.logo_file ? path.join(config.dataDir, s.logo_file) : '';
  if (logoPath && fs.existsSync(logoPath)) {
    try {
      pdf.image(logoPath, left, 50, { fit: logoFit });
      headerBottom = 50 + logoFit[1] + 5;
    } catch {
      /* unsupported image; fall back to text */
    }
  }
  if (headerBottom === 50 && s.business_name) {
    pdf.font(F.bold).fontSize(18).fillColor(heading).text(s.business_name, left, 50, { width: width / 2 });
    headerBottom = pdf.y + 10;
  }

  const bizLines = [
    s.business_name,
    ...cleanText(s.business_address).split('\n'),
    s.business_email,
    s.business_phone,
    displayUrl(s.business_website),
  ].filter((l) => l && l.trim());
  pdf.font(F.regular).fontSize(9).fillColor(GREY);
  pdf.text(bizLines.join('\n'), left + width / 2, 50, { width: width / 2, align: 'right' });
  headerBottom = Math.max(headerBottom, pdf.y + 15);

  return { pdf, done, left, right, width, F, accent, heading, headerBottom };
}

// Footer text on every page, then finish the document.
function finishPdf(ctx, label) {
  const { pdf, left, width, F } = ctx;
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    const fy = pdf.page.height - 40;
    const oldBottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf.font(F.regular).fontSize(8).fillColor(GREY);
    pdf.text(label, left, fy, { width: width / 2, lineBreak: false });
    pdf.text(`Page ${i - range.start + 1} of ${range.count}`, left + width / 2, fy, { width: width / 2, align: 'right', lineBreak: false });
    pdf.page.margins.bottom = oldBottom;
  }
  pdf.end();
  return ctx.done;
}

function renderPdf(doc) {
  const s = require('./businesses').effective(doc.business_id);
  const ctx = startPdf(s, `${doc.kind === 'invoice' ? 'Invoice' : 'Estimate'} ${doc.number}`);
  const { pdf, done, left, right, width, F, accent, heading } = ctx;
  let headerBottom = ctx.headerBottom;
  const money = (c) => formatMoney(c, doc.currency);

  // Title
  const title = doc.kind === 'invoice' ? 'INVOICE' : 'ESTIMATE';
  pdf.font(F.bold).fontSize(24).fillColor(heading).text(title, left, headerBottom);
  const stamp =
    doc.status === 'paid' ? 'PAID' : doc.status === 'void' ? 'VOID' : doc.status === 'accepted' ? 'ACCEPTED' : '';
  if (stamp) {
    const tw = pdf.widthOfString(title);
    pdf.font(F.bold).fontSize(12).fillColor(doc.status === 'void' ? '#b91c1c' : '#15803d');
    pdf.text(stamp, left + tw + 14, headerBottom + 8);
  }
  const blockTop = headerBottom + 40;

  // Bill to
  const c = doc.client;
  pdf.font(F.bold).fontSize(8).fillColor(GREY).text(doc.kind === 'invoice' ? 'BILL TO' : 'PREPARED FOR', left, blockTop);
  pdf.font(F.bold).fontSize(11).fillColor(DARK).text(c.name, left, pdf.y + 3, { width: width * 0.5 });
  const toLines = [c.contact_name, ...cleanText(c.address).split('\n')].filter((l) => l && l.trim());
  if (toLines.length) pdf.font(F.regular).fontSize(10).fillColor(DARK).text(toLines.join('\n'), { width: width * 0.5 });
  const billBottom = pdf.y;

  // Meta table
  const meta = [[doc.kind === 'invoice' ? 'Invoice number' : 'Estimate number', doc.number]];
  meta.push(['Issue date', formatDate(doc.issue_date)]);
  if (doc.due_date) meta.push([doc.kind === 'invoice' ? 'Due date' : 'Valid until', formatDate(doc.due_date)]);
  if (doc.po_number) meta.push(['PO number', doc.po_number]);
  if (doc.kind === 'invoice') meta.push(['Amount due', money(doc.balance_cents)]);
  else meta.push(['Total', money(doc.total_cents)]);
  let my = blockTop;
  const metaLabelX = left + width * 0.55;
  meta.forEach(([label, value], i) => {
    const last = i === meta.length - 1;
    pdf.font(F.regular).fontSize(9).fillColor(GREY).text(label, metaLabelX, my, { width: width * 0.2 });
    pdf.font(last ? F.bold : F.regular).fontSize(last ? 11 : 10).fillColor(DARK);
    pdf.text(value, metaLabelX + width * 0.2, my - (last ? 1 : 0), { width: width * 0.25, align: 'right' });
    my += 16;
  });

  let y = Math.max(billBottom, my) + 20;
  if (doc.subject) {
    pdf.font(F.bold).fontSize(11).fillColor(DARK).text(doc.subject, left, y, { width });
    y = pdf.y + 12;
  }

  // Line items table
  const showDates = doc.lines.some((l) => l.item_date);
  const cols = [];
  if (showDates) cols.push({ key: 'date', label: 'Date', w: 62, align: 'left' });
  cols.push({ key: 'desc', label: 'Description', w: 0, align: 'left' });
  cols.push({ key: 'qty', label: 'Qty', w: 45, align: 'right' });
  cols.push({ key: 'rate', label: 'Rate', w: 80, align: 'right' });
  cols.push({ key: 'amount', label: 'Amount', w: 85, align: 'right' });
  const fixed = cols.reduce((a, col) => a + col.w, 0);
  cols.find((col) => col.key === 'desc').w = width - fixed;
  const pad = 6;

  const bottomLimit = () => pdf.page.height - pdf.page.margins.bottom - 20;

  const drawHeader = () => {
    let x = left;
    pdf.font(F.bold).fontSize(8).fillColor(GREY);
    for (const col of cols) {
      pdf.text(col.label.toUpperCase(), x + (col.align === 'left' ? 0 : pad), y, { width: col.w - pad, align: col.align });
      x += col.w;
    }
    y += 14;
    pdf.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(accent).stroke();
    y += 6;
  };
  drawHeader();

  for (const line of doc.lines) {
    const descParts = [];
    const sub = [line.kind, line.project_name].filter(Boolean).join(' · ');
    const cells = {
      date: line.item_date ? formatShortDate(line.item_date) : '',
      qty: formatQuantity(line.quantity),
      rate: money(line.unit_price_cents),
      amount: money(line.amount_cents),
    };
    descParts.push(line.description || '');
    const descCol = cols.find((col) => col.key === 'desc');
    pdf.font(F.regular).fontSize(10);
    const descH = pdf.heightOfString(line.description || ' ', { width: descCol.w - pad });
    pdf.fontSize(8);
    const subH = sub ? pdf.heightOfString(sub, { width: descCol.w - pad }) + 2 : 0;
    const rowH = Math.max(descH + subH, 12) + 8;

    if (y + rowH > bottomLimit()) {
      pdf.addPage();
      y = pdf.page.margins.top;
      drawHeader();
    }

    let x = left;
    for (const col of cols) {
      if (col.key === 'desc') {
        if (sub) {
          pdf.font(F.regular).fontSize(8).fillColor(GREY).text(sub, x, y, { width: col.w - pad });
        }
        pdf.font(F.regular).fontSize(10).fillColor(DARK).text(line.description || '', x, y + subH, { width: col.w - pad });
      } else {
        pdf.font(F.regular).fontSize(10).fillColor(col.key === 'date' ? GREY : DARK);
        pdf.text(cells[col.key], x + (col.align === 'left' ? 0 : pad), y + (col.key === 'date' ? 0 : subH), {
          width: col.w - pad,
          align: col.align,
        });
      }
      x += col.w;
    }
    y += rowH;
    pdf.moveTo(left, y - 4).lineTo(right, y - 4).lineWidth(0.5).strokeColor(RULE).stroke();
  }

  // Totals
  const rows = [['Subtotal', money(doc.subtotal_cents)]];
  if (doc.discount_cents) rows.push([`Discount (${formatRate(doc.discount_percent)})`, `-${money(doc.discount_cents)}`]);
  for (const t of doc.taxes) {
    const label = `${t.name} (${formatRate(t.rate)})${t.reg_number ? `\nReg. #${t.reg_number}` : ''}`;
    rows.push([label, money(t.amount_cents)]);
  }
  rows.push(['Total', money(doc.total_cents), 'bold']);
  if (doc.kind === 'invoice' && doc.paid_cents) {
    rows.push(['Paid', `-${money(doc.paid_cents)}`]);
  }
  if (doc.kind === 'invoice') rows.push([`Balance due (${doc.currency})`, money(doc.balance_cents), 'due']);

  const totalsW = 300;
  const tx = right - totalsW;
  if (y + rows.length * 18 + 20 > bottomLimit()) {
    pdf.addPage();
    y = pdf.page.margins.top;
  }
  y += 6;
  for (const [label, value, style] of rows) {
    if (style === 'due') {
      pdf.rect(tx, y - 5, totalsW, 24).fill(accent);
      pdf.font(F.bold).fontSize(11).fillColor('#ffffff');
      pdf.text(label, tx + 8, y + 1, { width: totalsW - 100 });
      pdf.text(value, tx + totalsW - 120, y + 1, { width: 112, align: 'right' });
      y += 26;
    } else {
      pdf.font(style === 'bold' ? F.bold : F.regular).fontSize(10).fillColor(style === 'bold' ? DARK : GREY);
      const labelW = totalsW - 115;
      const h = pdf.heightOfString(label, { width: labelW });
      pdf.text(label, tx, y, { width: labelW });
      pdf.fillColor(DARK).text(value, tx + totalsW - 120, y, { width: 120, align: 'right' });
      y += Math.max(18, h + 6);
    }
  }

  // Notes, payment instructions, terms
  y += 14;
  const sections = [];
  if (doc.kind === 'invoice' && doc.balance_cents > 0 && doc.status !== 'void') {
    const stripeOn = config.stripeSecretKey && s.stripe_enabled === '1';
    if (stripeOn) sections.push(['Pay online', publicUrl(doc), true]);
    if (s.payment_instructions) sections.push(['Payment instructions', s.payment_instructions]);
  }
  if (doc.kind === 'estimate' && ['draft', 'sent'].includes(doc.status)) {
    sections.push(['Review and accept online', publicUrl(doc), true]);
  }
  if (doc.notes) sections.push(['Notes', doc.notes]);
  if (doc.terms) sections.push(['Terms', doc.terms]);

  for (const [label, text, isLink] of sections) {
    pdf.font(F.regular).fontSize(10);
    const h = pdf.heightOfString(text, { width }) + 18;
    if (y + h > bottomLimit()) {
      pdf.addPage();
      y = pdf.page.margins.top;
    }
    pdf.font(F.bold).fontSize(8).fillColor(GREY).text(label.toUpperCase(), left, y);
    pdf.font(F.regular).fontSize(10).fillColor(isLink ? accent : DARK);
    pdf.text(text, left, pdf.y + 3, { width, link: isLink ? text : undefined, underline: !!isLink });
    y = pdf.y + 14;
  }

  return finishPdf(ctx, `${doc.kind === 'invoice' ? 'Invoice' : 'Estimate'} ${doc.number}`);
}

const METHOD_LABELS = { stripe: 'Card (online)', etransfer: 'E-transfer', bank: 'Bank transfer', cheque: 'Cheque', cash: 'Cash', other: 'Other' };

function receiptNumber(doc, payment) {
  const n = (doc.payments || []).findIndex((p) => p.id === payment.id) + 1;
  return `${doc.number}-R${n || 1}`;
}

// A receipt for one payment on an invoice.
function renderReceiptPdf(doc, payment) {
  const s = require('./businesses').effective(doc.business_id);
  const number = receiptNumber(doc, payment);
  const ctx = startPdf(s, `Receipt ${number}`);
  const { pdf, left, right, width, F, accent, heading } = ctx;
  const money = (c) => formatMoney(c, doc.currency);
  let y = ctx.headerBottom;

  pdf.font(F.bold).fontSize(24).fillColor(heading).text('RECEIPT', left, y);
  const tw = pdf.widthOfString('RECEIPT');
  pdf.font(F.bold).fontSize(12).fillColor('#15803d').text('PAID', left + tw + 14, y + 8);
  y += 40;

  // Received from / receipt details
  const c = doc.client;
  pdf.font(F.bold).fontSize(8).fillColor(GREY).text('RECEIVED FROM', left, y);
  pdf.font(F.bold).fontSize(11).fillColor(DARK).text(c.name, left, pdf.y + 3, { width: width * 0.5 });
  const toLines = [c.contact_name, ...cleanText(c.address).split('\n')].filter((l) => l && l.trim());
  if (toLines.length) pdf.font(F.regular).fontSize(10).fillColor(DARK).text(toLines.join('\n'), { width: width * 0.5 });
  const leftBottom = pdf.y;

  const meta = [
    ['Receipt number', number],
    ['Payment date', formatDate(payment.paid_date)],
    ['Payment method', METHOD_LABELS[payment.method] || payment.method],
  ];
  if (payment.reference) meta.push(['Reference', payment.reference]);
  meta.push(['For invoice', doc.number]);
  let my = y;
  const labelX = left + width * 0.55;
  for (const [label, value] of meta) {
    pdf.font(F.regular).fontSize(9).fillColor(GREY).text(label, labelX, my, { width: width * 0.2 });
    pdf.font(F.regular).fontSize(10).fillColor(DARK).text(value, labelX + width * 0.2, my, { width: width * 0.25, align: 'right' });
    my += 16;
  }
  y = Math.max(leftBottom, my) + 26;

  // Big amount-received panel
  const panelH = 70;
  pdf.save();
  pdf.roundedRect(left, y, width, panelH, 8).fill(accent);
  pdf.restore();
  pdf.font(F.regular).fontSize(10).fillColor('#ffffff').text('AMOUNT RECEIVED', left + 20, y + 16, { width: width / 2 });
  pdf.font(F.bold).fontSize(26).fillColor('#ffffff').text(money(payment.amount_cents), left + width / 2, y + 20, { width: width / 2 - 20, align: 'right' });
  pdf.font(F.regular).fontSize(9).fillColor('#ffffff').text(doc.currency, left + 20, y + 34, { width: width / 2 });
  y += panelH + 26;

  // Invoice summary
  if (doc.subject) {
    pdf.font(F.bold).fontSize(11).fillColor(DARK).text(`Invoice ${doc.number}: ${doc.subject}`, left, y, { width });
    y = pdf.y + 10;
  }
  const paidBefore = (doc.payments || [])
    .filter((p) => p.id !== payment.id && (p.paid_date < payment.paid_date || (p.paid_date === payment.paid_date && p.id < payment.id)))
    .reduce((a, p) => a + p.amount_cents, 0);
  const remaining = doc.total_cents - paidBefore - payment.amount_cents;
  const rows = [
    ['Invoice total', money(doc.total_cents)],
    ...(paidBefore ? [['Previously paid', `-${money(paidBefore)}`]] : []),
    ['This payment', `-${money(payment.amount_cents)}`],
    ['Balance remaining', money(Math.max(0, remaining)), true],
  ];
  const tW = 280;
  const tx = right - tW;
  pdf.moveTo(tx, y).lineTo(right, y).lineWidth(1).strokeColor(accent).stroke();
  y += 10;
  for (const [label, value, bold] of rows) {
    pdf.font(bold ? F.bold : F.regular).fontSize(10).fillColor(bold ? DARK : GREY).text(label, tx, y, { width: tW - 120 });
    pdf.fillColor(DARK).text(value, tx + tW - 120, y, { width: 120, align: 'right' });
    y += 18;
  }
  for (const t of doc.taxes || []) {
    if (!t.reg_number) continue;
    y += 4;
    pdf.font(F.regular).fontSize(8).fillColor(GREY).text(`${t.name} registration #${t.reg_number}`, tx, y, { width: tW });
    y = pdf.y;
  }

  y += 30;
  pdf.font(F.regular).fontSize(11).fillColor(DARK).text(remaining <= 0 ? 'This invoice is paid in full. Thank you!' : 'Thank you for your payment!', left, y, { width });
  if (payment.notes) {
    pdf.font(F.regular).fontSize(9).fillColor(GREY).text(payment.notes, left, pdf.y + 8, { width });
  }
  return finishPdf(ctx, `Receipt ${number}`);
}

function receiptFilename(doc, payment) {
  const s = require('./businesses').effective(doc.business_id);
  const base = `${s.business_name ? `${s.business_name} ` : ''}Receipt ${receiptNumber(doc, payment)}`;
  return `${base.replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '-')}.pdf`;
}

function validColor(c, fallback) {
  return /^#[0-9a-f]{6}$/i.test(c || '') ? c : fallback;
}

function formatShortDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function pdfFilename(doc) {
  const s = require('./businesses').effective(doc.business_id);
  const base = `${s.business_name ? `${s.business_name} ` : ''}${doc.kind === 'invoice' ? 'Invoice' : 'Estimate'} ${doc.number}`;
  return `${base.replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '-')}.pdf`;
}

module.exports = { renderPdf, pdfFilename, publicUrl, renderReceiptPdf, receiptFilename, receiptNumber };
