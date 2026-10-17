// renderer/debtor-payments.js
//
// Cashier-side "Receive Debtor Payment" screen for employee-landing.html.
//
// WHAT IT DOES
//   When a customer who owes the shop (a debtor) comes in and pays some or all of
//   what they owe, the cashier opens the "Receive Debtor Payment" tab, picks the
//   debtor, enters the amount (+ method and M-Pesa code / reference), and saves.
//   The system then:
//     - stores the payment with the debtor, amount, method, reference, the exact
//       time it was captured, and which cashier captured it
//     - automatically deducts the amount from the debtor's balance
//       (and from their oldest unpaid credit sales first)
//     - shows it straight away on the owner's Debtors page (debtors.html), in the
//       customer's account statement, with the time and the cashier's name
//
// HOW IT IS WIRED
//   This file adds its own tab button, its own view and its own CSS to the page —
//   nothing else in employee-landing.html has to change except one line that loads
//   this file:   <script src="debtor-payments.js"></script>   (just before </body>)
//
//   It uses only API calls that already exist in preload.js / main.js:
//     window.pos.customers.accounts()        -> debtors, their sales and payments
//     window.pos.customers.recordPayment()   -> saves the payment + deducts balance
//     window.pos.auth.currentSession()       -> who is signed in
//   so there is NO change needed in main.js, preload.js or the database.

(function () {
  'use strict';
  if (window.__debtorPaymentsLoaded) return;
  window.__debtorPaymentsLoaded = true;

  // ------------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => 'KSh ' + Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 });
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  // The database stores timestamps as UTC text ("YYYY-MM-DD HH:MM:SS"); show them in local time.
  const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
  const fTime = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const fDate = (d) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const fDateTime = (d) => fDate(d) + ' · ' + fTime(d);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const toast = (m) => (typeof window.showToast === 'function' ? window.showToast(m) : window.alert(m));

  const METHODS = {
    'Cash':          { refLabel: 'Reference (optional)', refHint: '',                  refRequired: false },
    'M-Pesa':        { refLabel: 'M-Pesa code',          refHint: 'e.g. SKL4Z8Q2XP',   refRequired: true  },
    'Bank transfer': { refLabel: 'Bank reference',       refHint: 'transaction ref',   refRequired: true  },
    'Cheque':        { refLabel: 'Cheque number',        refHint: 'cheque no.',        refRequired: true  },
  };

  // -------------------------------------------------------------------- state
  let me = null;            // signed-in cashier { userId, name, ... }
  let DEBTORS = [];         // customers who currently owe money
  let PAYMENTS = [];        // every payment on record (for "captured today" + duplicate-code check)
  let selectedId = null;
  let mode = 'debtors';     // left panel: 'debtors' | 'today'
  let saving = false;
  let loadErr = '';
  let loaded = false;

  // ---------------------------------------------------------------------- CSS
  const css = `
  .dp-left{flex:1;display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0;}
  .dp-right{flex:0 0 400px;display:flex;flex-direction:column;min-height:0;}
  .dp-search{display:flex;align-items:center;gap:10px;padding:0 16px;min-height:46px;flex:0 0 auto;}
  .dp-search input{flex:1;border:none;background:transparent;font-size:14px;outline:none;color:var(--ink);font-family:'Inter',sans-serif;min-height:44px;}
  .dp-chips{display:flex;gap:8px;flex:0 0 auto;}
  .dp-chip{padding:0 16px;display:flex;align-items:center;gap:8px;font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-soft);border:1px solid var(--line);background:var(--paper);border-radius:3px;min-height:40px;font-weight:600;}
  .dp-chip.on{background:var(--teal);border-color:var(--teal);color:#fff;}
  .dp-chip em{font-style:normal;font-size:9.5px;padding:1px 7px;border-radius:10px;background:var(--stone-dim);color:var(--ink);}
  .dp-chip.on em{background:rgba(255,255,255,.25);color:#fff;}
  .dp-listplate{flex:1;padding:12px;overflow-y:auto;min-height:0;display:flex;flex-direction:column;}
  .dp-list{flex:1;display:flex;flex-direction:column;gap:8px;}
  .dp-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:3px;background:var(--stone);cursor:pointer;transition:.12s;}
  .dp-row:hover{border-color:var(--brass);background:var(--brass-soft);}
  .dp-row.sel{border-color:var(--teal);background:#fff;box-shadow:inset 3px 0 0 var(--teal);}
  .dp-row .n{font-weight:700;font-size:13.5px;}
  .dp-row .s{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--ink-soft);margin-top:3px;letter-spacing:.02em;}
  .dp-row .b{font-family:'IBM Plex Mono',monospace;font-weight:700;font-size:15px;color:var(--clay);white-space:nowrap;text-align:right;}
  .dp-row .b small{display:block;font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft);margin-top:2px;}
  .dp-row.pay .b{color:var(--forest);}
  .dp-pill{display:inline-block;font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;padding:2px 8px;border-radius:10px;background:var(--stone-dim);color:var(--ink-soft);margin-right:6px;}
  .dp-empty{padding:34px 14px;text-align:center;color:var(--ink-soft);font-size:12.5px;line-height:1.55;}
  .dp-foot{flex:0 0 auto;border-top:1px dashed var(--line);margin-top:10px;padding-top:10px;font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:var(--ink-soft);display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;}
  .dp-foot b{color:var(--ink);}
  .dp-formplate{flex:1;padding:18px 18px 16px;overflow-y:auto;min-height:0;}
  .dp-formplate h3{font-family:'Fraunces',serif;font-weight:700;font-size:16px;margin:0 0 14px;display:flex;align-items:center;gap:8px;}
  .dp-formplate h3 .sw{width:6px;height:16px;background:var(--brass);border-radius:1px;display:inline-block;}
  .dp-who .nm{font-family:'Fraunces',serif;font-weight:700;font-size:17px;}
  .dp-who .ph{font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:var(--ink-soft);margin-top:2px;}
  .dp-owed,.dp-after{display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--stone);border-radius:3px;padding:10px 12px;margin:12px 0;}
  .dp-owed span,.dp-after span{font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-soft);}
  .dp-owed b{font-family:'IBM Plex Mono',monospace;font-size:18px;color:var(--clay);}
  .dp-after b{font-family:'IBM Plex Mono',monospace;font-size:15px;color:var(--ink);}
  .dp-after.ok b{color:var(--forest);}
  .dp-amtrow{display:flex;gap:8px;}
  .dp-amtrow input{flex:1;font-family:'IBM Plex Mono',monospace;font-size:16px;font-weight:600;}
  .dp-mini{flex:0 0 auto;padding:0 12px;border:1px solid var(--brass);background:var(--brass-soft);color:var(--brass-deep);font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;border-radius:2px;min-height:40px;}
  .dp-mini:hover{background:var(--brass);color:#fff;}
  .dp-time{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--ink-soft);margin:2px 0 4px;letter-spacing:.03em;}
  .dp-time b{color:var(--ink);font-size:11px;}
  .dp-err{min-height:16px;color:var(--clay);font-size:12px;margin:6px 0 4px;font-weight:600;}
  .dp-save{width:100%;padding:12px;background:var(--forest);border:1px solid var(--forest);color:#fff;font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;border-radius:2px;min-height:46px;}
  .dp-save:hover{background:#175E4D;}
  .dp-save:disabled{background:var(--stone-dim);border-color:var(--stone-dim);color:var(--ink-soft);cursor:default;}
  .dp-idle{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;height:100%;color:var(--ink-soft);font-size:12.5px;line-height:1.6;padding:20px;}
  .dp-idle .ic{font-size:30px;margin-bottom:10px;}
  .dp-done{text-align:center;}
  .dp-done .tick{width:48px;height:48px;border-radius:50%;background:var(--forest-soft);color:var(--forest);font-size:26px;display:flex;align-items:center;justify-content:center;margin:2px auto 10px;}
  .dp-done h4{font-family:'Fraunces',serif;font-size:17px;margin:0 0 14px;}
  .dp-kv{text-align:left;border-top:1px dashed var(--line);padding-top:8px;margin-bottom:14px;}
  .dp-kv div{display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:12.5px;}
  .dp-kv span{color:var(--ink-soft);}
  .dp-kv b{text-align:right;font-weight:600;}
  .dp-kv .big b{font-family:'IBM Plex Mono',monospace;color:var(--forest);font-size:15px;}
  .dp-ov{display:none;position:fixed;inset:0;background:rgba(22,35,61,.55);z-index:1250;align-items:center;justify-content:center;padding:20px;}
  .dp-ov.on{display:flex;}
  .dp-modal{background:var(--paper);border:1px solid var(--brass);border-radius:4px;padding:24px;width:380px;max-width:92vw;box-shadow:0 12px 40px rgba(22,35,61,.35);}
  .dp-modal h3{font-family:'Fraunces',serif;font-size:17px;margin:0 0 12px;}
  .dp-modal .note{font-size:11.5px;color:var(--ink-soft);margin:10px 0 16px;line-height:1.5;}
  .dp-acts{display:flex;gap:10px;justify-content:flex-end;}
  .dp-acts button{padding:11px 18px;font-family:'IBM Plex Mono',monospace;font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;border-radius:2px;min-height:44px;border:1px solid var(--line);background:var(--stone);color:var(--ink-soft);}
  .dp-acts button.go{background:var(--forest);border-color:var(--forest);color:#fff;}
  @media (max-width:900px){.dp-right{flex:0 0 auto;}.dp-formplate{overflow:visible;}}
  `;

  // ------------------------------------------------------- inject tab + view
  function mount() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const tabs = document.querySelector('.tabs');
    const work = document.querySelector('.workarea');
    if (!tabs || !work) { console.error('[debtor-payments] page layout not found — tab not added'); return false; }

    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.id = 'tabBtnDebtor';
    btn.textContent = 'Receive Debtor Payment';
    btn.onclick = () => window.showView('debtor');
    tabs.appendChild(btn);

    const note = document.querySelector('.scope-note b');
    if (note) note.textContent = 'sales, stock entry & debtor payments';

    const view = document.createElement('div');
    view.className = 'view';
    view.id = 'viewDebtorPay';
    view.innerHTML = `
      <div class="dp-left">
        <div class="plate dp-search"><span class="bl"></span><span class="br"></span>
          <span style="color:var(--ink-soft);">🔍</span>
          <input type="text" id="dpSearch" placeholder="Search debtor by name or phone…" autocomplete="off">
        </div>
        <div class="dp-chips">
          <button class="dp-chip on" id="dpChipDebtors">Who owes us <em id="dpCntDebtors">0</em></button>
          <button class="dp-chip" id="dpChipToday">Captured today <em id="dpCntToday">0</em></button>
        </div>
        <div class="plate dp-listplate"><span class="bl"></span><span class="br"></span>
          <div class="dp-list" id="dpList"></div>
          <div class="dp-foot" id="dpFoot"></div>
        </div>
      </div>
      <div class="dp-right">
        <div class="plate dp-formplate" id="dpFormPlate"><span class="bl"></span><span class="br"></span>
          <h3><span class="sw"></span>Receive Payment</h3>
          <div id="dpForm"></div>
        </div>
      </div>`;
    work.appendChild(view);

    const ov = document.createElement('div');
    ov.className = 'dp-ov';
    ov.id = 'dpConfirm';
    ov.innerHTML = `<div class="dp-modal">
        <h3>Confirm payment received</h3>
        <div class="dp-kv" id="dpConfirmBody"></div>
        <div class="note">Once saved, this is deducted from the debtor's balance straight away and the owner sees it on the Debtors page. A cashier cannot undo it, so check the details.</div>
        <div class="dp-acts"><button id="dpConfirmBack">Back</button><button class="go" id="dpConfirmGo">Yes, save payment</button></div>
      </div>`;
    document.body.appendChild(ov);

    // Hook the page's existing tab switcher so the other tabs still work and ours is hidden/shown too.
    const originalShowView = window.showView;
    window.showView = function (v) {
      if (typeof originalShowView === 'function') originalShowView(v);
      const on = v === 'debtor';
      view.classList.toggle('on', on);
      btn.classList.toggle('on', on);
      if (on) refresh();
    };

    $('dpSearch').addEventListener('input', renderLeft);
    $('dpChipDebtors').onclick = () => setMode('debtors');
    $('dpChipToday').onclick = () => setMode('today');
    $('dpConfirmBack').onclick = closeConfirm;
    ov.addEventListener('click', (e) => { if (e.target === ov) closeConfirm(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeConfirm(); });
    return true;
  }

  // --------------------------------------------------------------------- data
  async function refresh() {
    try {
      if (!me) me = await window.pos.auth.currentSession();
      const data = await window.pos.customers.accounts();
      DEBTORS = data
        .filter((a) => a.customer.total_owed > 0.005)
        .map((a) => {
          const pays = a.payments.slice().sort((x, y) => x.id - y.id);
          return {
            id: a.customer.id, name: a.customer.name, phone: a.customer.phone || '',
            owed: r2(a.customer.total_owed), last: pays.length ? pays[pays.length - 1] : null,
          };
        })
        .sort((a, b) => b.owed - a.owed);
      PAYMENTS = [];
      data.forEach((a) => a.payments.forEach((p) =>
        PAYMENTS.push({ ...p, customerId: a.customer.id, customerName: a.customer.name })));
      loadErr = '';
    } catch (err) {
      loadErr = (err && err.message) || String(err);
    }
    loaded = true;
    // If the selected debtor no longer owes anything (cleared from another screen), drop the selection.
    const selectionLost = selectedId != null && !DEBTORS.some((d) => d.id === selectedId);
    if (selectionLost) selectedId = null;
    renderLeft();
    if (selectionLost) renderForm();
  }

  function setMode(m) {
    mode = m;
    $('dpChipDebtors').classList.toggle('on', m === 'debtors');
    $('dpChipToday').classList.toggle('on', m === 'today');
    renderLeft();
  }

  const todaysMine = () => {
    const now = new Date();
    return PAYMENTS
      .filter((p) => me && p.recorded_by === me.name && sameDay(parseUtc(p.date), now))
      .sort((a, b) => b.id - a.id);
  };

  // ------------------------------------------------------------- left panel
  function renderLeft() {
    const q = ($('dpSearch').value || '').trim().toLowerCase();
    const mine = todaysMine();
    $('dpCntDebtors').textContent = DEBTORS.length;
    $('dpCntToday').textContent = mine.length;
    const list = $('dpList'), foot = $('dpFoot');

    if (loadErr) {
      list.innerHTML = `<div class="dp-empty">Could not load debtors: ${esc(loadErr)}</div>`;
      foot.innerHTML = '';
      return;
    }
    if (!loaded) { list.innerHTML = `<div class="dp-empty">Loading…</div>`; foot.innerHTML = ''; return; }

    if (mode === 'debtors') {
      const rows = DEBTORS.filter((d) => d.name.toLowerCase().includes(q) || d.phone.includes(q));
      list.innerHTML = rows.map((d) => `
        <div class="dp-row ${d.id === selectedId ? 'sel' : ''}" data-id="${d.id}">
          <div><div class="n">${esc(d.name)}</div>
          <div class="s">${esc(d.phone || 'No phone')} · ${d.last ? 'last paid ' + esc(fDate(parseUtc(d.last.date))) : 'no payments yet'}</div></div>
          <div class="b">${money(d.owed)}<small>owes</small></div>
        </div>`).join('') ||
        `<div class="dp-empty">${DEBTORS.length
          ? 'No debtor matches that search.'
          : 'Nobody owes the shop right now.<br>A customer appears here automatically when a sale is completed with the <b>Credit</b> payment option.'}</div>`;
      list.querySelectorAll('.dp-row').forEach((el) => (el.onclick = () => select(Number(el.dataset.id))));
      const total = DEBTORS.reduce((a, d) => a + d.owed, 0);
      foot.innerHTML = `<span>${DEBTORS.length} debtor${DEBTORS.length === 1 ? '' : 's'}</span><span>Total owed <b>${money(total)}</b></span>`;
    } else {
      const rows = mine.filter((p) => p.customerName.toLowerCase().includes(q));
      list.innerHTML = rows.map((p) => `
        <div class="dp-row pay">
          <div><div class="n">${esc(p.customerName)}</div>
          <div class="s">${esc(fTime(parseUtc(p.date)))} · <span class="dp-pill">${esc(p.method || '—')}</span>${p.reference ? esc(p.reference) : ''}</div></div>
          <div class="b">${money(p.amount)}<small>received</small></div>
        </div>`).join('') ||
        `<div class="dp-empty">You have not captured any debtor payments today.</div>`;
      const total = mine.reduce((a, p) => a + p.amount, 0);
      const byMethod = {};
      mine.forEach((p) => { const m = p.method || 'Other'; byMethod[m] = r2((byMethod[m] || 0) + p.amount); });
      foot.innerHTML = `<span>${mine.length} payment${mine.length === 1 ? '' : 's'} · ${Object.keys(byMethod).map((m) => esc(m) + ' ' + money(byMethod[m])).join(' · ') || '—'}</span><span>Total <b>${money(total)}</b></span>`;
    }
  }

  function select(id) {
    selectedId = id;
    renderLeft();
    renderForm();
  }

  // ------------------------------------------------------------------- form
  let nowTimer = null;
  function renderForm() {
    clearInterval(nowTimer);
    const box = $('dpForm');
    const d = DEBTORS.find((x) => x.id === selectedId);
    if (!d) {
      box.innerHTML = `<div class="dp-idle"><div class="ic">💰</div>Pick the customer who is paying from the list on the left,<br>then enter how much they paid.</div>`;
      return;
    }
    box.innerHTML = `
      <div class="dp-who"><div class="nm">${esc(d.name)}</div><div class="ph">${esc(d.phone || 'No phone on file')}</div></div>
      <div class="dp-owed"><span>Outstanding balance</span><b>${money(d.owed)}</b></div>
      <div class="form-field"><label>Amount received (KSh)</label>
        <div class="dp-amtrow"><input type="number" id="dpAmt" min="0" step="any" inputmode="decimal" placeholder="0">
        <button type="button" class="dp-mini" id="dpFull">Full balance</button></div></div>
      <div class="form-grid-2">
        <div class="form-field"><label>Paid by</label>
          <select id="dpMethod">${Object.keys(METHODS).map((m) => `<option>${esc(m)}</option>`).join('')}</select></div>
        <div class="form-field"><label id="dpRefLbl"></label><input type="text" id="dpRef" autocomplete="off"></div>
      </div>
      <div class="dp-time">Time of payment: <b id="dpNow"></b> — recorded automatically on save</div>
      <div class="dp-after" id="dpAfterBox"><span>Balance after this payment</span><b id="dpAfter"></b></div>
      <div class="dp-err" id="dpErr"></div>
      <button class="dp-save" id="dpSave">Record Payment</button>`;

    const amt = $('dpAmt'), method = $('dpMethod'), ref = $('dpRef');
    const syncMethod = () => {
      const m = METHODS[method.value];
      $('dpRefLbl').textContent = m.refLabel;
      ref.placeholder = m.refHint;
      ref.style.textTransform = m.refRequired ? 'uppercase' : 'none';
    };
    const syncAfter = () => {
      const a = Number(amt.value) || 0;
      const after = r2(d.owed - a);
      $('dpAfter').textContent = after < 0 ? 'More than owed' : (after <= 0.005 ? 'KSh 0 — fully cleared' : money(after));
      $('dpAfterBox').classList.toggle('ok', after >= 0 && after <= 0.005 && a > 0);
      $('dpErr').textContent = '';
    };
    const tickNow = () => { $('dpNow').textContent = fTime(new Date()); };
    method.onchange = () => { syncMethod(); $('dpErr').textContent = ''; };
    amt.oninput = syncAfter;
    ref.oninput = () => { $('dpErr').textContent = ''; };
    $('dpFull').onclick = () => { amt.value = d.owed; syncAfter(); amt.focus(); };
    $('dpSave').onclick = () => askConfirm(d);
    amt.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); askConfirm(d); } });
    syncMethod(); syncAfter(); tickNow();
    nowTimer = setInterval(tickNow, 15000);
    amt.focus();
  }

  // Returns {amount, method, reference} or shows an inline error and returns null.
  function validate(d) {
    const err = (m) => { $('dpErr').textContent = m; return null; };
    const amount = r2($('dpAmt').value);
    const method = $('dpMethod').value;
    let reference = $('dpRef').value.trim();
    if (METHODS[method].refRequired) reference = reference.toUpperCase(); // M-Pesa / bank codes are upper-case
    if (!(amount > 0)) return err('Enter the amount the customer paid.');
    if (amount > d.owed + 0.005) return err(`That is more than ${d.name} owes (${money(d.owed)}).`);
    if (METHODS[method].refRequired && !reference) return err(`Enter the ${METHODS[method].refLabel.toLowerCase()} so the owner can verify this payment.`);
    if (reference) {
      const dup = PAYMENTS.find((p) => p.reference && String(p.reference).trim().toUpperCase() === reference.toUpperCase());
      if (dup) return err(`The code ${reference} was already recorded for ${dup.customerName} on ${fDateTime(parseUtc(dup.date))}. Check you are not entering the same payment twice.`);
    }
    return { amount, method, reference };
  }

  let pending = null;
  function askConfirm(d) {
    if (saving) return;
    const v = validate(d);
    if (!v) return;
    pending = { d, v };
    const after = r2(d.owed - v.amount);
    $('dpConfirmBody').innerHTML = `
      <div><span>Debtor</span><b>${esc(d.name)}</b></div>
      <div><span>Amount received</span><b>${money(v.amount)}</b></div>
      <div><span>Paid by</span><b>${esc(v.method)}${v.reference ? ' · ' + esc(v.reference) : ''}</b></div>
      <div><span>Balance before</span><b>${money(d.owed)}</b></div>
      <div class="big"><span>Balance after</span><b>${after <= 0.005 ? 'KSh 0 (cleared)' : money(after)}</b></div>`;
    $('dpConfirm').classList.add('on');
    $('dpConfirmGo').onclick = save;
    $('dpConfirmGo').focus();
  }
  function closeConfirm() { $('dpConfirm').classList.remove('on'); }

  async function save() {
    if (saving || !pending) return;
    saving = true;
    const { d, v } = pending;
    const go = $('dpConfirmGo');
    go.disabled = true; go.textContent = 'Saving…';
    try {
      // saleId = null -> the backend applies it to the debtor's oldest unpaid credit sales first.
      // No date is passed, so the backend stamps the exact current time.
      const updated = await window.pos.customers.recordPayment(d.id, v.amount, null, {
        method: v.method, reference: v.reference || null,
      });
      closeConfirm();
      await refresh();
      // Show the time exactly as the system stored it.
      const saved = PAYMENTS.filter((p) => p.customerId === d.id).sort((a, b) => b.id - a.id)[0];
      showDone(d, v, updated, saved);
    } catch (err) {
      closeConfirm();
      $('dpErr') && ($('dpErr').textContent = 'Could not save: ' + ((err && err.message) || err));
      toast('Could not save the payment: ' + ((err && err.message) || err));
    } finally {
      saving = false; pending = null;
      go.disabled = false; go.textContent = 'Yes, save payment';
    }
  }

  function showDone(d, v, updated, saved) {
    clearInterval(nowTimer);
    const newBal = updated ? r2(updated.total_owed) : r2(d.owed - v.amount);
    const when = saved ? parseUtc(saved.date) : new Date();
    selectedId = null;
    renderLeft();
    $('dpForm').innerHTML = `
      <div class="dp-done">
        <div class="tick">✓</div>
        <h4>Payment recorded</h4>
        <div class="dp-kv">
          <div><span>Debtor</span><b>${esc(d.name)}</b></div>
          <div><span>Amount received</span><b>${money(v.amount)}</b></div>
          <div><span>Paid by</span><b>${esc(v.method)}${v.reference ? ' · ' + esc(v.reference) : ''}</b></div>
          <div><span>Time</span><b>${esc(fDateTime(when))}</b></div>
          <div><span>Received by</span><b>${esc((me && me.name) || '—')}</b></div>
          <div class="big"><span>Balance now</span><b>${newBal <= 0.005 ? 'KSh 0 — cleared' : money(newBal)}</b></div>
        </div>
        <button class="dp-save" id="dpAnother">Record another payment</button>
      </div>`;
    $('dpAnother').onclick = () => { renderForm(); $('dpSearch').focus(); };
    toast(`${money(v.amount)} received from ${d.name}.`);
  }

  // --------------------------------------------------------------------- boot
  if (mount()) {
    renderForm();
    // Pick up payments/credit sales made elsewhere while this tab is open.
    setInterval(() => {
      const view = $('viewDebtorPay');
      if (view && view.classList.contains('on') && !saving) refresh();
    }, 30000);
  }
})();
