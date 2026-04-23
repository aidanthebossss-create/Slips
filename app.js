(() => {
  const DB_NAME = 'slips-db';
  const DB_VERSION = 1;
  const STORE = 'slips';

  let db;
  let pendingBlob = null;
  let currentSlip = null;
  const objectURLs = new Set();

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          const os = d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          os.createIndex('date', 'date');
          os.createIndex('category', 'category');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function req2p(r) {
    return new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  const store = mode => db.transaction(STORE, mode).objectStore(STORE);
  const addSlip = s => req2p(store('readwrite').add(s));
  const getAll = () => req2p(store('readonly').getAll());
  const updateSlip = s => req2p(store('readwrite').put(s));
  const deleteSlip = id => req2p(store('readwrite').delete(id));

  const NUM_RE = /([0-9]{1,3}(?:[ ,.][0-9]{3})*[.,][0-9]{2}|[0-9]+[.,][0-9]{2})/g;

  function lastNumber(line) {
    const nums = [...line.matchAll(NUM_RE)];
    if (!nums.length) return null;
    return toNumber(nums[nums.length - 1][1]);
  }

  function parseAmount(text) {
    if (!text) return null;
    const clean = text.replace(/\r/g, '');
    const lines = clean.split('\n');

    const totalHits = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/sub[\s-]*total/i.test(line)) continue;
      if (/\btotals?\b/i.test(line)) {
        totalHits.push({ i, line, grand: /grand[\s-]*total/i.test(line) });
      }
    }
    totalHits.sort((a, b) => (b.grand - a.grand) || (b.i - a.i));

    for (const hit of totalHits) {
      const n = lastNumber(hit.line);
      if (n != null) return n;
      const next = lines[hit.i + 1];
      if (next) {
        const n2 = lastNumber(next);
        if (n2 != null) return n2;
      }
    }

    const keywordRe = /(amount\s*due|balance|amount|due|paid)/i;
    for (const line of lines) {
      if (keywordRe.test(line)) {
        const n = lastNumber(line);
        if (n != null) return n;
      }
    }

    const allNums = [...clean.matchAll(NUM_RE)]
      .map(m => toNumber(m[1]))
      .filter(n => n !== null && n > 0 && n < 1000000);
    if (allNums.length) return Math.max(...allNums);
    return null;
  }

  function toNumber(raw) {
    if (raw == null) return null;
    let s = String(raw).replace(/\s/g, '');
    if (!s) return null;
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function formatMoney(n) {
    if (n == null || isNaN(n)) return 'R 0.00';
    return 'R ' + n.toFixed(2);
  }

  function todayISO() {
    const d = new Date();
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 10);
  }

  const $ = sel => document.querySelector(sel);
  const $$ = sel => document.querySelectorAll(sel);

  function haptic(ms) {
    if (navigator.vibrate) try { navigator.vibrate(ms); } catch (_) {}
  }

  let toastTimer;
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (kind === 'error' ? ' error' : '');
    t.hidden = false;
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => { t.hidden = true; }, 250);
    }, 2200);
  }

  function bindCatPills(container) {
    const pills = container.querySelectorAll('.cat-pill');
    pills.forEach(p => p.addEventListener('click', () => {
      pills.forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      container.dataset.selected = p.dataset.cat;
      haptic(5);
    }));
  }
  function setCatPill(container, value) {
    const pills = container.querySelectorAll('.cat-pill');
    pills.forEach(p => p.classList.toggle('active', p.dataset.cat === value));
    if (value) container.dataset.selected = value;
    else delete container.dataset.selected;
  }

  bindCatPills($('#cat-group'));
  bindCatPills($('#viewer-cat-group'));

  function freeObjectURLs() {
    for (const url of objectURLs) URL.revokeObjectURL(url);
    objectURLs.clear();
  }
  function makeURL(blob) {
    const u = URL.createObjectURL(blob);
    objectURLs.add(u);
    return u;
  }

  function switchView(name) {
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    $$('.tabbar .tab').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    $('#page-title').textContent = name === 'capture' ? 'Capture' : 'Slips';
    window.scrollTo(0, 0);
    if (name === 'browse') renderBrowse();
  }
  $$('.tabbar .tab').forEach(b => b.addEventListener('click', () => {
    switchView(b.dataset.view);
    haptic(5);
  }));

  $('#start-capture').addEventListener('click', () => {
    $('#file').click();
  });

  $('#file').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    pendingBlob = file;

    const url = makeURL(file);
    $('#preview').src = url;
    $('#empty-capture').hidden = true;
    $('#workflow').hidden = false;
    $('#date').value = todayISO();
    $('#amount').value = '';
    $('#ocr-text').textContent = '';
    setCatPill($('#cat-group'), null);

    const statusEl = $('#ocr-status');
    statusEl.className = 'status-chip';
    statusEl.textContent = 'Reading text…';

    try {
      const result = await Tesseract.recognize(file, 'eng', {
        logger: m => {
          if (m.status === 'recognizing text') {
            statusEl.textContent = `Reading text ${Math.round(m.progress * 100)}%`;
          }
        }
      });
      const text = result.data.text || '';
      $('#ocr-text').textContent = text;
      const amt = parseAmount(text);
      if (amt != null) {
        $('#amount').value = amt.toFixed(2);
        statusEl.className = 'status-chip ok';
        statusEl.textContent = `Detected total: R ${amt.toFixed(2)}`;
      } else {
        statusEl.className = 'status-chip error';
        statusEl.textContent = 'No total found — type it in';
      }
    } catch (err) {
      statusEl.className = 'status-chip error';
      statusEl.textContent = 'OCR failed — type amount manually';
    }
  });

  $('#discard').addEventListener('click', () => {
    resetCaptureView();
    haptic(5);
  });

  function resetCaptureView() {
    pendingBlob = null;
    $('#file').value = '';
    $('#workflow').hidden = true;
    $('#empty-capture').hidden = false;
    $('#ocr-status').textContent = '';
    $('#ocr-status').className = 'status-chip';
  }

  $('#entry').addEventListener('submit', async e => {
    e.preventDefault();
    if (!pendingBlob) return;
    const amount = toNumber($('#amount').value);
    if (amount == null) { toast('Enter an amount', 'error'); return; }
    const date = $('#date').value;
    if (!date) { toast('Pick a date', 'error'); return; }
    const cat = $('#cat-group').dataset.selected;
    if (!cat) { toast('Pick a category', 'error'); return; }
    const ocrText = $('#ocr-text').textContent || '';
    await addSlip({
      blob: pendingBlob,
      amount,
      date,
      category: cat,
      ocrText,
      createdAt: Date.now()
    });
    resetCaptureView();
    haptic(15);
    toast('Slip saved');
    switchView('browse');
  });

  async function renderBrowse() {
    const filter = $('#filter-cat').value;
    const all = await getAll();
    const filtered = filter ? all.filter(s => s.category === filter) : all;

    freeObjectURLs();

    let grand = 0;
    for (const s of filtered) grand += s.amount;
    $('#hero-amount').textContent = formatMoney(grand);
    $('#hero-label').textContent = filter ? `Category ${filter} total` : 'Total';
    $('#hero-sub').textContent = `${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'}`;

    const tree = $('#tree');
    tree.innerHTML = '';
    if (!filtered.length) {
      tree.innerHTML = `
        <div class="empty-state" style="padding: 40px 24px;">
          <p class="empty-title" style="font-size:18px">Nothing here yet</p>
          <p class="empty-sub">Saved slips will show up grouped by year and month.</p>
        </div>`;
      return;
    }

    filtered.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

    const grouped = {};
    for (const s of filtered) {
      const [y, m] = s.date.split('-');
      grouped[y] ??= {};
      grouped[y][m] ??= {};
      grouped[y][m][s.category] ??= [];
      grouped[y][m][s.category].push(s);
    }

    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const cats = ['1','2','3','4','5'];

    for (const y of Object.keys(grouped).sort().reverse()) {
      const yTotal = Object.values(grouped[y]).flatMap(cm => Object.values(cm)).flat().reduce((s, x) => s + x.amount, 0);
      const yEl = document.createElement('details');
      yEl.className = 'year';
      yEl.open = true;
      yEl.innerHTML = `<summary><span>${y}</span><span class="sum-total">${formatMoney(yTotal)}</span></summary>`;

      for (const m of Object.keys(grouped[y]).sort().reverse()) {
        const mTotal = Object.values(grouped[y][m]).flat().reduce((s, x) => s + x.amount, 0);
        const mEl = document.createElement('details');
        mEl.className = 'month';
        mEl.open = true;
        mEl.innerHTML = `<summary><span>${monthNames[parseInt(m, 10) - 1]}</span><span class="sum-total">${formatMoney(mTotal)}</span></summary>`;

        for (const c of cats) {
          const slips = grouped[y][m][c];
          if (!slips) continue;
          const catTotal = slips.reduce((s, x) => s + x.amount, 0);
          const cEl = document.createElement('div');
          cEl.className = 'cat-sec';
          cEl.innerHTML = `<h4><span>Category ${c}</span><span class="cat-total">${formatMoney(catTotal)}</span></h4>`;
          const grid = document.createElement('div');
          grid.className = 'slips';
          for (const s of slips) {
            const el = document.createElement('div');
            el.className = 'slip';
            el.dataset.id = s.id;
            const day = parseInt(s.date.split('-')[2], 10);
            const url = makeURL(s.blob);
            el.innerHTML = `
              <img src="${url}" alt="" />
              <div class="tag"><span>${day}</span><span>${s.amount.toFixed(2)}</span></div>
            `;
            el.addEventListener('click', () => openViewer(s));
            grid.appendChild(el);
          }
          cEl.appendChild(grid);
          mEl.appendChild(cEl);
        }
        yEl.appendChild(mEl);
      }
      tree.appendChild(yEl);
    }
  }

  function openViewer(s) {
    currentSlip = s;
    $('#viewer-img').src = makeURL(s.blob);
    $('#viewer-amount').value = s.amount.toFixed(2);
    $('#viewer-date').value = s.date;
    setCatPill($('#viewer-cat-group'), s.category);
    $('#viewer').hidden = false;
    haptic(5);
  }

  function closeViewer() {
    $('#viewer').hidden = true;
    currentSlip = null;
  }

  $('#viewer-close').addEventListener('click', closeViewer);

  $('#viewer-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!currentSlip) return;
    const amount = toNumber($('#viewer-amount').value);
    if (amount == null) { toast('Invalid amount', 'error'); return; }
    const date = $('#viewer-date').value;
    if (!date) { toast('Pick a date', 'error'); return; }
    const cat = $('#viewer-cat-group').dataset.selected;
    if (!cat) { toast('Pick a category', 'error'); return; }
    const updated = { ...currentSlip, amount, date, category: cat };
    await updateSlip(updated);
    haptic(12);
    toast('Updated');
    closeViewer();
    renderBrowse();
  });

  $('#viewer-delete').addEventListener('click', async () => {
    if (!currentSlip) return;
    if (!confirm('Delete this slip?')) return;
    await deleteSlip(currentSlip.id);
    haptic(20);
    toast('Deleted');
    closeViewer();
    renderBrowse();
  });

  $('#filter-cat').addEventListener('change', renderBrowse);

  $('#export').addEventListener('click', async () => {
    const all = await getAll();
    if (!all.length) { toast('Nothing to export', 'error'); return; }
    const header = 'id,date,year,month,day,category,amount\n';
    const rows = all.map(s => {
      const [y, m, d] = s.date.split('-');
      return [s.id, s.date, y, m, d, s.category, s.amount.toFixed(2)].join(',');
    }).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `slips-${todayISO()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Exported');
  });

  (async () => {
    db = await openDB();
    $('#date').value = todayISO();
  })();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
