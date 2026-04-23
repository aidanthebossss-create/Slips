(() => {
  const DB_NAME = 'slips-db';
  const DB_VERSION = 1;
  const STORE = 'slips';

  let db;
  let pendingBlob = null;

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

  function tx(mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  function addSlip(slip) {
    return new Promise((resolve, reject) => {
      const r = tx('readwrite').add(slip);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function getAll() {
    return new Promise((resolve, reject) => {
      const r = tx('readonly').getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  function deleteSlip(id) {
    return new Promise((resolve, reject) => {
      const r = tx('readwrite').delete(id);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }

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
    if (!raw) return null;
    let s = raw.replace(/\s/g, '');
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function formatMoney(n) {
    if (n == null || isNaN(n)) return '-';
    return n.toFixed(2);
  }

  function todayISO() {
    const d = new Date();
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 10);
  }

  const $ = sel => document.querySelector(sel);
  const $$ = sel => document.querySelectorAll(sel);

  function switchView(name) {
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    $$('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'browse') renderBrowse();
  }

  $$('nav button').forEach(b => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });

  $('#file').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    pendingBlob = file;
    const url = URL.createObjectURL(file);
    $('#preview').src = url;
    $('#preview-wrap').hidden = false;
    $('#entry').hidden = false;
    $('#date').value = todayISO();
    $('#amount').value = '';
    $('#ocr-text').textContent = '';
    const statusEl = $('#ocr-status');
    statusEl.textContent = 'Reading text...';
    try {
      const result = await Tesseract.recognize(file, 'eng', {
        logger: m => {
          if (m.status === 'recognizing text') {
            statusEl.textContent = `Reading text... ${Math.round(m.progress * 100)}%`;
          } else if (m.status) {
            statusEl.textContent = m.status;
          }
        }
      });
      const text = result.data.text || '';
      $('#ocr-text').textContent = text;
      const amt = parseAmount(text);
      if (amt != null) {
        $('#amount').value = formatMoney(amt);
        statusEl.textContent = `Detected amount: ${formatMoney(amt)}`;
      } else {
        statusEl.textContent = 'Could not detect amount — enter manually';
      }
    } catch (err) {
      statusEl.textContent = 'OCR failed: ' + err.message + ' — enter amount manually';
    }
  });

  $('#discard').addEventListener('click', () => {
    pendingBlob = null;
    $('#file').value = '';
    $('#preview-wrap').hidden = true;
    $('#entry').hidden = true;
    $('#ocr-status').textContent = '';
  });

  $('#entry').addEventListener('submit', async e => {
    e.preventDefault();
    if (!pendingBlob) return;
    const amount = toNumber($('#amount').value);
    if (amount == null) { alert('Enter a valid amount'); return; }
    const date = $('#date').value;
    if (!date) { alert('Pick a date'); return; }
    const cat = $('#cat-group input:checked');
    if (!cat) { alert('Pick a category'); return; }
    const ocrText = $('#ocr-text').textContent || '';
    await addSlip({
      blob: pendingBlob,
      amount,
      date,
      category: cat.value,
      ocrText,
      createdAt: Date.now()
    });
    pendingBlob = null;
    $('#file').value = '';
    $('#preview-wrap').hidden = true;
    $('#entry').hidden = true;
    $('#ocr-status').textContent = '';
    switchView('browse');
  });

  async function renderBrowse() {
    const filter = $('#filter-cat').value;
    const all = await getAll();
    const filtered = filter ? all.filter(s => s.category === filter) : all;

    const totals = $('#totals');
    const byCat = {};
    let grand = 0;
    for (const s of filtered) {
      byCat[s.category] = (byCat[s.category] || 0) + s.amount;
      grand += s.amount;
    }
    const rows = ['1','2','3','4','5'].map(c =>
      `<div class="row-t"><span>Category ${c}</span><span>${formatMoney(byCat[c] || 0)}</span></div>`
    ).join('');
    totals.innerHTML = rows + `<div class="row-t grand"><span>Total (${filtered.length})</span><span>${formatMoney(grand)}</span></div>`;

    const tree = $('#tree');
    tree.innerHTML = '';
    if (!filtered.length) {
      tree.innerHTML = '<p style="color:var(--muted);text-align:center;padding:24px">No slips yet.</p>';
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
      yEl.innerHTML = `<summary>${y}<span class="sum-total">${formatMoney(yTotal)}</span></summary>`;
      for (const m of Object.keys(grouped[y]).sort().reverse()) {
        const mTotal = Object.values(grouped[y][m]).flat().reduce((s, x) => s + x.amount, 0);
        const mEl = document.createElement('details');
        mEl.className = 'month';
        mEl.open = true;
        mEl.innerHTML = `<summary>${monthNames[parseInt(m,10)-1]}<span class="sum-total">${formatMoney(mTotal)}</span></summary>`;
        for (const c of cats) {
          const slips = grouped[y][m][c];
          if (!slips) continue;
          const catTotal = slips.reduce((sum, s) => sum + s.amount, 0);
          const cEl = document.createElement('div');
          cEl.className = 'cat-sec';
          cEl.innerHTML = `<h4>Category ${c}<span class="cat-total">${formatMoney(catTotal)}</span></h4>`;
          const grid = document.createElement('div');
          grid.className = 'slips';
          for (const s of slips) {
            const el = document.createElement('div');
            el.className = 'slip';
            el.dataset.id = s.id;
            const url = URL.createObjectURL(s.blob);
            const day = parseInt(s.date.split('-')[2], 10);
            el.innerHTML = `
              <img src="${url}" alt="" />
              <div class="tag"><span>${day}</span><span>${formatMoney(s.amount)}</span></div>
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
    $('#viewer-img').src = URL.createObjectURL(s.blob);
    $('#viewer-info').innerHTML = `
      <strong>${formatMoney(s.amount)}</strong>
      Category ${s.category} · ${s.date}
    `;
    $('#viewer-delete').onclick = async () => {
      if (!confirm('Delete this slip?')) return;
      await deleteSlip(s.id);
      $('#viewer').hidden = true;
      renderBrowse();
    };
    $('#viewer').hidden = false;
  }

  $('#viewer-close').addEventListener('click', () => {
    $('#viewer').hidden = true;
  });

  $('#filter-cat').addEventListener('change', renderBrowse);

  $('#export').addEventListener('click', async () => {
    const all = await getAll();
    if (!all.length) { alert('Nothing to export'); return; }
    const header = 'id,date,year,month,day,category,amount\n';
    const rows = all.map(s => {
      const [y,m,d] = s.date.split('-');
      return [s.id, s.date, y, m, d, s.category, s.amount].join(',');
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
