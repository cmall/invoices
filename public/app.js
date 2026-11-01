'use strict';
(function () {
  // Confirm before destructive form submits.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var msg = form.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // Disable a button and show progress text for slow actions.
  document.querySelectorAll('[data-busy]').forEach(function (btn) {
    btn.form && btn.form.addEventListener('submit', function () {
      btn.disabled = true;
      btn.textContent = btn.getAttribute('data-busy');
    });
  });

  // Copy-to-clipboard.
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = btn.parentElement.querySelector('[data-copy-source]');
      input.select();
      (navigator.clipboard ? navigator.clipboard.writeText(input.value) : Promise.reject())
        .catch(function () { document.execCommand('copy'); })
        .finally(function () {
          btn.textContent = 'Copied';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
        });
    });
  });

  // Quick-add: choosing a project fills its rate.
  document.querySelectorAll('[data-quickadd]').forEach(function (form) {
    var select = form.querySelector('[data-project-select]');
    var rate = form.querySelector('[data-rate-input]');
    if (!select || !rate) return;
    select.addEventListener('change', function () {
      var opt = select.options[select.selectedIndex];
      var r = opt && opt.getAttribute('data-rate');
      if (r) rate.value = r;
    });
  });

  // Theme switcher: light / system / dark, remembered in this browser.
  function markTheme() {
    var pref = document.documentElement.getAttribute('data-theme-pref') || 'system';
    document.querySelectorAll('[data-theme-set]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-theme-set') === pref);
      b.setAttribute('aria-pressed', b.getAttribute('data-theme-set') === pref ? 'true' : 'false');
    });
  }
  document.querySelectorAll('[data-theme-set]').forEach(function (b) {
    b.addEventListener('click', function () {
      var pref = b.getAttribute('data-theme-set');
      try { localStorage.setItem('theme', pref); } catch (e) {}
      document.documentElement.setAttribute('data-theme-pref', pref);
      if (window.__applyTheme) window.__applyTheme();
      markTheme();
    });
  });
  markTheme();

  // Mobile menu.
  var menuBtn = document.querySelector('[data-menu]');
  if (menuBtn) {
    menuBtn.addEventListener('click', function () {
      document.querySelector('[data-sidebar]').classList.toggle('open');
    });
  }

  // Live update log while an update runs, then reload once the new version is up.
  var jobEl = document.querySelector('[data-update-job]');
  if (jobEl && (jobEl.getAttribute('data-running') === '1' || jobEl.getAttribute('data-restarting') === '1')) {
    var startSha = jobEl.getAttribute('data-sha');
    var logEl = jobEl.querySelector('[data-job-log]');
    var badge = jobEl.querySelector('[data-job-badge]');
    var poll = function () {
      fetch('/updates/status', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
        .then(function (data) {
          var j = data.job;
          if (data.sha && data.sha !== startSha && (!j || !j.running)) {
            window.location.href = '/updates?msg=' + encodeURIComponent('Updated to ' + data.sha);
            return;
          }
          if (j) {
            logEl.textContent = j.log;
            logEl.scrollTop = logEl.scrollHeight;
            badge.textContent = j.running ? 'running' : j.ok ? (j.restarting ? 'restarting' : 'done') : 'failed';
            if (!j.running && !j.restarting) { window.location.reload(); return; }
          }
          setTimeout(poll, 1500);
        })
        .catch(function () {
          badge.textContent = 'restarting';
          setTimeout(poll, 2000);
        });
    };
    setTimeout(poll, 1000);
  }

  // Auto-submit file inputs (logo upload).
  document.querySelectorAll('[data-autosubmit]').forEach(function (input) {
    input.addEventListener('change', function () { if (input.files.length) input.form.submit(); });
  });

  var branding = document.querySelector('[data-branding]');
  if (branding) initBranding(branding);

  function initBranding(root) {
    var preview = root.querySelector('[data-preview]');
    var isHex = function (v) { return /^#[0-9a-f]{6}$/i.test(v); };
    function setColor(which, value, from) {
      if (!isHex(value)) return;
      var picker = root.querySelector('[data-color="' + which + '"]');
      var text = root.querySelector('[data-hex="' + which + '"]');
      if (from !== picker) picker.value = value.toLowerCase();
      if (from !== text) text.value = value.toLowerCase();
      preview.style.setProperty('--' + which, value);
      if (which === 'accent') document.documentElement.style.setProperty('--accent', value);
      markActive();
    }
    function markActive() {
      var a = root.querySelector('[data-color="accent"]').value.toLowerCase();
      var h = root.querySelector('[data-color="heading"]').value.toLowerCase();
      root.querySelectorAll('.swatch').forEach(function (sw) {
        sw.classList.toggle('active', sw.getAttribute('data-accent') === a && sw.getAttribute('data-heading') === h);
      });
    }
    ['accent', 'heading'].forEach(function (which) {
      var picker = root.querySelector('[data-color="' + which + '"]');
      var text = root.querySelector('[data-hex="' + which + '"]');
      picker.addEventListener('input', function () { setColor(which, picker.value, picker); });
      text.addEventListener('input', function () {
        var v = text.value.trim();
        if (v && v[0] !== '#') v = '#' + v;
        setColor(which, v, text);
      });
    });
    root.querySelectorAll('.swatch').forEach(function (sw) {
      sw.addEventListener('click', function () {
        setColor('accent', sw.getAttribute('data-accent'));
        setColor('heading', sw.getAttribute('data-heading'));
      });
    });
    root.querySelectorAll('input[name=invoice_font]').forEach(function (r) {
      r.addEventListener('change', function () {
        preview.classList.toggle('font-classic', r.value === 'classic' && r.checked);
        preview.classList.toggle('font-modern', r.value === 'modern' && r.checked);
      });
    });
    root.querySelectorAll('input[name=logo_size]').forEach(function (r) {
      r.addEventListener('change', function () {
        preview.classList.remove('logo-small', 'logo-medium', 'logo-large');
        preview.classList.add('logo-' + r.value);
      });
    });
    markActive();
  }

  var editor = document.querySelector('[data-doc-editor]');
  if (editor) initEditor(editor);

  function initEditor(form) {
    var data = JSON.parse(document.getElementById('editor-data').textContent);
    var lines = data.lines.length ? data.lines : [blankLine()];
    var taxes = data.taxes;
    var tbody = form.querySelector('[data-lines] tbody');
    var taxBody = form.querySelector('[data-taxes] tbody');
    var totalsEl = form.querySelector('[data-totals]');
    var clientSelect = form.querySelector('[data-client-select]');
    var currencySelect = form.querySelector('[data-currency]');
    var discountInput = form.querySelector('[data-discount]');
    var KINDS = ['Service', 'Product', 'Expense', 'Other'];

    function blankLine() {
      return { item_date: '', project_id: '', kind: 'Service', description: '', quantity: '1', unit_price: '', taxable: true };
    }
    function num(v) {
      var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
      return isFinite(n) ? n : 0;
    }
    function cents(v) { return Math.round(num(v) * 100); }
    function money(c) {
      try {
        return new Intl.NumberFormat('en-CA', { style: 'currency', currency: currencySelect.value }).format(c / 100);
      } catch (e) {
        return (c / 100).toFixed(2);
      }
    }
    function el(tag, attrs, children) {
      var n = document.createElement(tag);
      Object.keys(attrs || {}).forEach(function (k) {
        if (k === 'className') n.className = attrs[k];
        else if (k === 'text') n.textContent = attrs[k];
        else n.setAttribute(k, attrs[k]);
      });
      (children || []).forEach(function (c) { n.appendChild(c); });
      return n;
    }
    function clientProjects() {
      var cid = Number(clientSelect.value);
      return data.projects.filter(function (p) { return p.client_id === cid; });
    }

    function renderLines() {
      tbody.innerHTML = '';
      lines.forEach(function (line, i) {
        var tr = el('tr');

        var date = el('input', { type: 'date', value: line.item_date || '' });
        date.addEventListener('input', function () { line.item_date = date.value; });
        tr.appendChild(el('td', { className: 'c-date' }, [date]));

        var proj = el('select');
        proj.appendChild(el('option', { value: '', text: '—' }));
        clientProjects().forEach(function (p) {
          var o = el('option', { value: p.id, text: p.name });
          if (String(p.id) === String(line.project_id)) o.selected = true;
          proj.appendChild(o);
        });
        proj.addEventListener('change', function () {
          line.project_id = proj.value;
          var p = data.projects.find(function (x) { return String(x.id) === proj.value; });
          if (p && p.rate) { line.unit_price = p.rate; renderLines(); }
        });
        tr.appendChild(el('td', { className: 'c-project' }, [proj]));

        var kind = el('select');
        var kinds = KINDS.indexOf(line.kind) === -1 && line.kind ? KINDS.concat([line.kind]) : KINDS;
        kinds.forEach(function (k) {
          var o = el('option', { value: k, text: k });
          if (k === line.kind) o.selected = true;
          kind.appendChild(o);
        });
        kind.addEventListener('change', function () { line.kind = kind.value; });
        tr.appendChild(el('td', { className: 'c-kind' }, [kind]));

        var desc = el('textarea', { rows: '1' });
        desc.value = line.description || '';
        var grow = function () { desc.style.height = 'auto'; desc.style.height = desc.scrollHeight + 'px'; };
        desc.addEventListener('input', function () { line.description = desc.value; grow(); });
        tr.appendChild(el('td', { className: 'c-desc' }, [desc]));
        setTimeout(grow, 0);

        var qty = el('input', { inputmode: 'decimal', value: line.quantity, className: 'num' });
        qty.addEventListener('input', function () { line.quantity = qty.value; updateAmounts(); });
        tr.appendChild(el('td', { className: 'c-qty' }, [qty]));

        var price = el('input', { inputmode: 'decimal', value: line.unit_price, className: 'num', placeholder: '0.00' });
        price.addEventListener('input', function () { line.unit_price = price.value; updateAmounts(); });
        tr.appendChild(el('td', { className: 'c-price' }, [price]));

        var tax = el('input', { type: 'checkbox', title: 'Taxable' });
        tax.checked = line.taxable !== false;
        tax.addEventListener('change', function () { line.taxable = tax.checked; updateAmounts(); });
        tr.appendChild(el('td', { className: 'c-tax center' }, [tax]));

        tr.appendChild(el('td', { className: 'c-amount num', 'data-amount': i }));

        var up = el('button', { type: 'button', className: 'icon', title: 'Move up', text: '↑' });
        up.disabled = i === 0;
        up.addEventListener('click', function () { lines.splice(i - 1, 0, lines.splice(i, 1)[0]); renderLines(); });
        var del = el('button', { type: 'button', className: 'icon danger', title: 'Remove line', text: '×' });
        del.addEventListener('click', function () { lines.splice(i, 1); if (!lines.length) lines.push(blankLine()); renderLines(); });
        tr.appendChild(el('td', { className: 'c-actions' }, [up, del]));

        tbody.appendChild(tr);
      });
      updateAmounts();
    }

    function renderTaxes() {
      taxBody.innerHTML = '';
      if (!taxes.length) {
        taxBody.appendChild(el('tr', {}, [el('td', { className: 'muted', text: 'No taxes on this document.' })]));
      }
      taxes.forEach(function (t, i) {
        var name = el('input', { value: t.name, placeholder: 'Name' });
        name.addEventListener('input', function () { t.name = name.value; updateAmounts(); });
        var rate = el('input', { value: t.rate, inputmode: 'decimal', className: 'num w-sm', placeholder: '%' });
        rate.addEventListener('input', function () { t.rate = rate.value; t.fixed_amount_cents = null; updateAmounts(); });
        var reg = el('input', { value: t.reg_number || '', placeholder: 'Registration # (optional)' });
        reg.addEventListener('input', function () { t.reg_number = reg.value; });
        var del = el('button', { type: 'button', className: 'icon danger', title: 'Remove tax', text: '×' });
        del.addEventListener('click', function () { taxes.splice(i, 1); renderTaxes(); });
        var row = el('tr', {}, [
          el('td', {}, [name]),
          el('td', {}, [rate]),
          el('td', {}, [reg]),
          el('td', { className: 'c-actions' }, [del]),
        ]);
        taxBody.appendChild(row);
        if (t.fixed_amount_cents != null) {
          taxBody.appendChild(el('tr', {}, [el('td', { colspan: '4', className: 'hint', text: 'Imported amount kept as-is. Edit the rate to recalculate.' })]));
        }
      });
      updateAmounts();
    }

    function computeTotals() {
      var subtotal = 0, taxable = 0;
      var amounts = lines.map(function (l) {
        var a = Math.round(num(l.quantity) * cents(l.unit_price));
        subtotal += a;
        if (l.taxable !== false) taxable += a;
        return a;
      });
      var pct = Math.min(Math.max(num(discountInput.value), 0), 100);
      var discount = Math.round(subtotal * pct / 100);
      var base = taxable - Math.round(taxable * pct / 100);
      var taxAmounts = taxes.map(function (t) {
        return t.fixed_amount_cents != null ? Number(t.fixed_amount_cents) : Math.round(base * num(t.rate) / 100);
      });
      var tax = taxAmounts.reduce(function (a, b) { return a + b; }, 0);
      return { amounts: amounts, subtotal: subtotal, discount: discount, pct: pct, taxAmounts: taxAmounts, total: subtotal - discount + tax };
    }

    function updateAmounts() {
      var t = computeTotals();
      t.amounts.forEach(function (a, i) {
        var cell = tbody.querySelector('[data-amount="' + i + '"]');
        if (cell) cell.textContent = money(a);
      });
      totalsEl.innerHTML = '';
      function row(label, value, cls) {
        totalsEl.appendChild(el('dt', { className: cls || '', text: label }));
        totalsEl.appendChild(el('dd', { className: cls || '', text: value }));
      }
      row('Subtotal', money(t.subtotal));
      if (t.discount) row('Discount (' + t.pct + '%)', '-' + money(t.discount));
      taxes.forEach(function (tx, i) { row((tx.name || 'Tax') + ' (' + num(tx.rate) + '%)', money(t.taxAmounts[i])); });
      row('Total', money(t.total), 'strong');
    }

    form.querySelector('[data-add-line]').addEventListener('click', function () {
      var last = lines[lines.length - 1];
      var l = blankLine();
      if (last) { l.project_id = last.project_id; l.unit_price = last.unit_price; l.kind = last.kind; l.taxable = last.taxable; }
      lines.push(l);
      renderLines();
      var descs = tbody.querySelectorAll('textarea');
      if (descs.length) descs[descs.length - 1].focus();
    });

    var addTax = form.querySelector('[data-add-tax-select]');
    addTax.addEventListener('change', function () {
      if (addTax.value === 'custom') {
        taxes.push({ tax_rate_id: null, name: 'Tax', rate: '', reg_number: '', fixed_amount_cents: null });
      } else if (addTax.value) {
        var r = data.taxRates.find(function (x) { return String(x.id) === addTax.value; });
        if (r) taxes.push({ tax_rate_id: r.id, name: r.name, rate: r.rate, reg_number: r.reg_number, fixed_amount_cents: null });
      }
      addTax.value = '';
      renderTaxes();
    });

    clientSelect.addEventListener('change', function () {
      var c = data.clients.find(function (x) { return String(x.id) === clientSelect.value; });
      if (c && c.currency) currencySelect.value = c.currency;
      renderLines();
    });
    currencySelect.addEventListener('change', updateAmounts);
    discountInput.addEventListener('input', updateAmounts);

    var dirty = false;
    form.addEventListener('input', function () { dirty = true; });
    window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

    form.addEventListener('submit', function () {
      dirty = false;
      form.querySelector('[name=lines_json]').value = JSON.stringify(lines);
      form.querySelector('[name=taxes_json]').value = JSON.stringify(taxes);
    });

    renderLines();
    renderTaxes();
  }
})();
