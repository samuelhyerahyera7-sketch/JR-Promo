/* JR Promotions stock system: single-page frontend (no build step). */
(() => {
  'use strict';

  // ------------------------------------------------------------------ helpers

  const ZAR = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' });
  const NUM = new Intl.NumberFormat('en-ZA');
  const money = (n) => ZAR.format(n || 0);
  const num = (n) => NUM.format(n || 0);

  /** Server timestamps are UTC ("YYYY-MM-DD HH:MM:SS" or ISO); plain dates are calendar dates. */
  function parseDate(s) {
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  }
  const fmtDate = (s) => (s ? parseDate(s).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const fmtDateTime = (s) =>
    s ? parseDate(s).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const ROLE_NAMES = {
    director: 'Director',
    office: 'Office staff',
    account_manager: 'Account manager',
    warehouse: 'Warehouse',
    promoter: 'Promoter',
  };
  const MOVEMENT_NAMES = {
    receipt: 'Received',
    dispatch: 'Dispatched',
    transfer: 'Transfer',
    adjustment: 'Stock-take adj.',
    return: 'Returned',
    usage: 'Used in field',
    damage: 'Damaged',
    laundry: 'To laundry',
    laundered: 'Laundered',
    write_off: 'Expired write-off',
  };
  const HANDOVER_NAMES = { collection: 'Collected at warehouse', dispatch: 'Sent out', delivery: 'Delivery confirmed', return: 'Returned' };
  const GENDER_NAMES = { female: 'Ladies', male: 'Mens', unisex: 'Unisex' };
  const DELIVERY = { collect: 'Collect from warehouse', courier: 'Courier', company_vehicle: 'JR vehicle' };

  /** Element builder. Strings become text nodes, so user data is never parsed as HTML. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className = v;
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, children);
    return el;
  }
  function append(el, ...children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const badge = (status, label) => h('span', { class: `badge ${status}` }, label || status);

  async function api(method, path, body) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/auth/login') {
      state.user = null;
      renderLogin();
      throw new Error(data.error || 'Please sign in');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  const get = (path) => api('GET', path);
  const post = (path, body) => api('POST', path, body || {});
  const put = (path, body) => api('PUT', path, body);
  const patch = (path, body) => api('PATCH', path, body);
  const qs = (params) => {
    const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();
    return s ? `?${s}` : '';
  };

  function toast(message, kind = '') {
    const el = h('div', { class: `toast ${kind}` }, message);
    document.getElementById('toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
  }

  /** Run an async action from a button, disabling it while busy and toasting errors. */
  async function busy(button, fn) {
    if (button) button.disabled = true;
    try {
      return await fn();
    } catch (err) {
      toast(err.message, 'error');
      return undefined;
    } finally {
      if (button) button.disabled = false;
    }
  }

  const openModals = new Set();
  function modal(title, body, buttons = [], { onClose, wide } = {}) {
    const onKey = (e) => e.key === 'Escape' && close();
    const close = () => {
      if (!openModals.has(close)) return;
      openModals.delete(close);
      back.remove();
      document.removeEventListener('keydown', onKey);
      if (onClose) onClose();
    };
    openModals.add(close);
    document.addEventListener('keydown', onKey);
    const back = h(
      'div',
      { class: 'modal-back', onmousedown: (e) => e.target === back && close() },
      h(
        'div',
        { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('header', null, h('h2', { style: 'margin:0' }, title), h('button', { onclick: close, 'aria-label': 'Close' }, '×')),
        h('div', { class: 'body' }, body),
        buttons.length ? h('footer', null, buttons) : null,
      ),
    );
    document.body.append(back);
    const first = back.querySelector('input, select, textarea');
    if (first) first.focus();
    return { close, el: back };
  }

  function field(label, input, { hint, full } = {}) {
    return h('div', { class: `field${full ? ' full' : ''}` }, h('label', null, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  }
  const input = (attrs = {}) => h('input', attrs);
  function select(options, attrs = {}, placeholder) {
    const el = h('select', attrs);
    if (placeholder !== undefined) el.append(h('option', { value: '' }, placeholder));
    for (const o of options) {
      if (o.group) {
        const g = h('optgroup', { label: o.group });
        for (const c of o.options) g.append(h('option', { value: c.value, selected: String(c.value) === String(attrs.value) }, c.label));
        el.append(g);
      } else {
        el.append(h('option', { value: o.value, selected: String(o.value) === String(attrs.value) }, o.label));
      }
    }
    if (attrs.value !== undefined) el.value = attrs.value ?? '';
    return el;
  }

  function table(columns, rows, { onRow, rowClass, empty = 'Nothing to show yet' } = {}) {
    if (!rows.length) return h('div', { class: 'empty' }, empty);
    return h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, columns.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
        h(
          'tbody',
          null,
          rows.map((r) =>
            h(
              'tr',
              { class: [onRow ? 'clickable' : '', rowClass ? rowClass(r) : ''].join(' ').trim() || null, onclick: onRow ? () => onRow(r) : null },
              columns.map((c) => h('td', { class: [c.num ? 'num' : '', c.class || ''].join(' ').trim() || null }, c.render ? c.render(r) : r[c.key] ?? '—')),
            ),
          ),
        ),
      ),
    );
  }

  /**
   * Editable list of product lines. `products` is [{id, label, group?, hint?, tracksExpiry?}];
   * returns {el, values(), add(line)} where values() gives [{product_id, qty, bin?, batch_no?, expiry_date?}].
   * add() tops up an existing line for the same product, e.g. when scanning or adding a kit.
   */
  function linesEditor(products, { withBin = false, withBatch = false, qtyLabel = 'Qty', initial = [] } = {}) {
    const wrap = h('div', { class: 'lines' });
    const grouped = [];
    const byGroup = new Map();
    for (const p of products) {
      if (p.group) {
        if (!byGroup.has(p.group)) {
          const g = { group: p.group, options: [] };
          byGroup.set(p.group, g);
          grouped.push(g);
        }
        byGroup.get(p.group).options.push({ value: p.id, label: p.label });
      } else grouped.push({ value: p.id, label: p.label });
    }
    const hints = new Map(products.map((p) => [String(p.id), p.hint]));
    const meta = new Map(products.map((p) => [String(p.id), p]));
    const addLine = (pre = {}) => {
      const sel = select(grouped, { value: pre.product_id ?? '' }, 'Choose product…');
      const hint = h('div', { class: 'hint' });
      const batch = withBatch ? input({ placeholder: 'Batch / lot no.', maxlength: '40', value: pre.batch_no || '' }) : null;
      const expiry = withBatch ? input({ type: 'date', title: 'Expiry date', value: pre.expiry_date || '' }) : null;
      const batchRow = withBatch
        ? h('div', { class: 'batch-row' }, h('label', { class: 'small' }, 'Batch & expiry (required for dated stock)'), h('div', { class: 'batch-fields' }, batch, expiry))
        : null;
      const onChange = () => {
        hint.textContent = hints.get(sel.value) || '';
        if (batchRow) batchRow.hidden = !(meta.get(sel.value) || {}).tracksExpiry;
      };
      sel.addEventListener('change', onChange);
      onChange();
      const qty = input({ type: 'number', min: '1', step: '1', placeholder: qtyLabel, value: pre.qty ?? '', inputmode: 'numeric' });
      const bin = withBin ? input({ placeholder: 'Bin', class: 'bin', maxlength: '30' }) : null;
      const row = h(
        'div',
        { class: `line${withBin ? ' with-bin' : ''}` },
        h('div', null, sel, hint, batchRow),
        qty,
        bin,
        h('button', { type: 'button', class: 'secondary', title: 'Remove line', onclick: () => row.remove() }, '×'),
      );
      row._sel = sel;
      row._qty = qty;
      row._get = () => ({
        product_id: Number(sel.value),
        qty: Number(qty.value),
        bin: bin ? bin.value : undefined,
        batch_no: batch && !batchRow.hidden ? batch.value : undefined,
        expiry_date: expiry && !batchRow.hidden ? expiry.value : undefined,
      });
      wrap.append(row);
      return row;
    };
    const el = h(
      'div',
      null,
      wrap,
      h('button', { type: 'button', class: 'secondary small', style: 'margin-top:8px', onclick: () => addLine() }, '+ Add product'),
    );
    if (initial.length) initial.forEach(addLine);
    else addLine();
    const values = () => [...wrap.children].map((r) => r._get()).filter((l) => l.product_id || l.qty);
    const add = (line) => {
      if (!meta.has(String(line.product_id))) return false;
      const rows = [...wrap.children];
      const existing = rows.find((r) => r._sel.value === String(line.product_id));
      if (existing) {
        existing._qty.value = Number(existing._qty.value || 0) + (line.qty || 1);
        return true;
      }
      const blank = rows.find((r) => !r._sel.value && !r._qty.value);
      if (blank) blank.remove();
      addLine({ ...line, qty: line.qty || 1 });
      return true;
    };
    el.refreshHints = (fn) => {
      for (const p of products) hints.set(String(p.id), fn(p));
      wrap.querySelectorAll('.line > div > select').forEach((s) => s.dispatchEvent(new Event('change')));
    };
    return { el, values, add };
  }

  // ------------------------------------------------------------------ scanning, signatures, photos, QR

  const scripts = new Map();
  function loadScript(src) {
    if (!scripts.has(src)) {
      scripts.set(
        src,
        new Promise((resolve, reject) => {
          const el = document.createElement('script');
          el.src = src;
          el.onload = resolve;
          el.onerror = () => reject(new Error(`Could not load ${src}`));
          document.head.append(el);
        }),
      );
    }
    return scripts.get(src);
  }

  /**
   * Camera QR scanner with a typed/handheld-scanner fallback. onCode(code) may return
   * a message (or promise of one) shown under the video when keepOpen is set.
   */
  function scanner(onCode, { title = 'Scan QR code', keepOpen = false, help } = {}) {
    const video = h('video', { playsinline: true, muted: true, autoplay: true, class: 'scan-video' });
    const status = h('div', { class: 'scan-status' }, help || 'Point the camera at a QR code. Handheld scanners and typing work too.');
    const manual = input({ placeholder: 'Type or scan a code…', autocomplete: 'off', autocapitalize: 'characters' });
    let stream;
    let timer;
    let stopped = false;
    let last = '';
    let lastAt = 0;
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
    const handle = async (raw) => {
      const code = String(raw || '').trim();
      if (!code) return;
      const now = Date.now();
      if (code === last && now - lastAt < 2500) return;
      last = code;
      lastAt = now;
      if (navigator.vibrate) navigator.vibrate(60);
      if (!keepOpen) m.close();
      try {
        const msg = await onCode(code);
        if (keepOpen && msg) {
          status.textContent = msg;
          status.className = 'scan-status ok';
        }
      } catch (err) {
        if (keepOpen) {
          status.textContent = err.message;
          status.className = 'scan-status error';
        } else toast(err.message, 'error');
      }
    };
    manual.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handle(manual.value);
        manual.value = '';
      }
    });
    const m = modal(
      title,
      h(
        'div',
        null,
        video,
        status,
        h('div', { class: 'scan-manual' }, manual, h('button', { type: 'button', onclick: () => { handle(manual.value); manual.value = ''; } }, 'Go')),
      ),
      keepOpen ? [h('button', { onclick: () => m.close() }, 'Done')] : [],
      { onClose: stop },
    );
    (async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        video.hidden = true;
        status.textContent = 'No camera available here. Type the code or use a handheld scanner.';
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch {
        video.hidden = true;
        status.textContent = 'Camera not allowed. Type the code or use a handheld scanner.';
        return;
      }
      if (stopped) return stop();
      video.srcObject = stream;
      await video.play().catch(() => {});
      let detect = null;
      if ('BarcodeDetector' in window) {
        try {
          const detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'ean_13'] });
          detect = async () => ((await detector.detect(video))[0] || {}).rawValue;
        } catch {
          detect = null;
        }
      }
      if (!detect) {
        await loadScript('/vendor/jsQR.js');
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        detect = async () => {
          if (!video.videoWidth) return null;
          const scale = Math.min(1, 640 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const found = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          return found && found.data;
        };
      }
      const tick = async () => {
        if (stopped) return;
        try {
          const code = await detect();
          if (code) await handle(code);
        } catch {
          /* keep scanning */
        }
        if (!stopped) timer = setTimeout(tick, 250);
      };
      tick();
    })();
    return m;
  }

  /** Product SKU from a scanned code: JRP:SKU[:batch], or a raw SKU. */
  const skuFromCode = (code) => (code.startsWith('JRP:') ? code.split(':')[1] : code).toUpperCase();

  /** Finger/mouse signature box. value() returns a PNG data URL, or null if nothing was drawn. */
  function signaturePad(label = 'Promoter signature') {
    const canvas = h('canvas', { width: 600, height: 180, class: 'sigpad', 'aria-label': label });
    const ctx = canvas.getContext('2d');
    const reset = () => {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111';
    };
    reset();
    let drawing = false;
    let dirty = false;
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
    };
    canvas.addEventListener('pointerdown', (e) => {
      drawing = true;
      dirty = true;
      canvas.setPointerCapture(e.pointerId);
      ctx.beginPath();
      ctx.moveTo(...pos(e));
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      ctx.lineTo(...pos(e));
      ctx.stroke();
    });
    for (const t of ['pointerup', 'pointercancel']) canvas.addEventListener(t, () => (drawing = false));
    const el = h(
      'div',
      { class: 'sig-wrap' },
      h('label', null, label),
      canvas,
      h('div', { class: 'sig-foot' }, h('span', { class: 'hint' }, 'Sign with a finger or mouse'), h('button', { type: 'button', class: 'secondary small', onclick: () => { reset(); dirty = false; } }, 'Clear')),
    );
    return { el, value: () => (dirty ? canvas.toDataURL('image/png') : null) };
  }

  const readDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Could not read the file'));
      r.readAsDataURL(file);
    });

  /** Photos are shrunk to max 1800px JPEG before upload so phone pictures stay small. */
  async function fileToDataUrl(file) {
    if (file.type === 'application/pdf') return readDataUrl(file);
    if (!file.type.startsWith('image/')) throw new Error(`${file.name}: choose a photo or PDF`);
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return readDataUrl(file);
    }
    const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  async function uploadFiles(target, files, caption) {
    for (const file of files) {
      const data = await fileToDataUrl(file);
      await post('/attachments', { ...target, caption, filename: file.name, data });
    }
  }

  /** Two buttons (camera / gallery) that hand chosen files to onFiles. */
  function filePicker(onFiles, { label = 'Add photo' } = {}) {
    const mk = (capture) => {
      const el = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: !capture, hidden: true });
      if (capture) el.setAttribute('capture', 'environment');
      el.addEventListener('change', () => {
        if (el.files.length) onFiles([...el.files]);
        el.value = '';
      });
      return el;
    };
    const cam = mk(true);
    const pick = mk(false);
    return h(
      'div',
      { class: 'file-picker' },
      cam,
      pick,
      h('button', { type: 'button', class: 'secondary small', onclick: () => cam.click() }, `📷 ${label}`),
      h('button', { type: 'button', class: 'secondary small', onclick: () => pick.click() }, 'Choose files'),
    );
  }

  /** Thumbnails of uploaded files plus an uploader. target identifies the parent for the API. */
  function attachmentsPanel(target, initial, { canUpload = true, title = 'Photos & documents', emptyText = 'No photos yet' } = {}) {
    const grid = h('div', { class: 'thumbs' });
    const caption = input({ placeholder: 'Caption (optional), e.g. "Waybill" or "Damaged box"', maxlength: '200' });
    const status = h('div', { class: 'hint' });
    const draw = (list) => {
      grid.replaceChildren(
        ...(list.length
          ? list.map((a) => {
              const url = `/api/attachments/${a.id}/file`;
              const canDelete = a.uploaded_by === state.user.id || isMgmt();
              return h(
                'figure',
                { class: 'thumb' },
                h(
                  'a',
                  { href: url, target: '_blank', rel: 'noopener' },
                  a.mime === 'application/pdf' ? h('div', { class: 'pdf' }, 'PDF') : h('img', { src: url, alt: a.caption || a.filename || 'Photo', loading: 'lazy' }),
                ),
                h('figcaption', null, a.caption || a.filename || '', h('div', { class: 'muted' }, `${a.uploaded_by_name}, ${fmtDateTime(a.created_at)}`)),
                canDelete && a.uploaded_by !== undefined
                  ? h('button', {
                      type: 'button',
                      class: 'thumb-del',
                      title: 'Delete',
                      onclick: () => busy(null, async () => {
                        if (!confirm('Delete this file?')) return;
                        await api('DELETE', `/attachments/${a.id}`);
                        reload();
                      }),
                    }, '×')
                  : null,
              );
            })
          : [h('div', { class: 'muted small' }, emptyText)]),
      );
    };
    const reload = async () => draw(await get(`/attachments${qs(target)}`));
    draw(initial || []);
    if (!initial) reload();
    const picker = filePicker(async (files) => {
      status.textContent = `Uploading ${files.length} file(s)…`;
      try {
        await uploadFiles(target, files, caption.value);
        caption.value = '';
        status.textContent = '';
        toast('Uploaded', 'ok');
        reload();
      } catch (err) {
        status.textContent = '';
        toast(err.message, 'error');
      }
    });
    return h('div', { class: 'attachments' }, title ? h('h3', null, title) : null, grid, canUpload ? h('div', { class: 'upload-row no-print' }, caption, picker) : null, status);
  }

  const qrImg = (text, size = 120) =>
    h('img', { src: `/api/qr.svg?text=${encodeURIComponent(text)}`, width: size, height: size, alt: text, class: 'qr' });

  const sizeOrder = (s) => {
    const i = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'].indexOf(s);
    return i === -1 ? 99 : i;
  };

  // ------------------------------------------------------------------ state, nav, routing

  const state = { user: null, counts: {}, lookups: {} };
  const role = () => state.user && state.user.role;
  const isMgmt = () => ['director', 'office'].includes(role());
  const isOps = () => isMgmt() || role() === 'warehouse';
  const canSeeStock = () => isOps() || role() === 'account_manager';
  const canSeeCost = () => isMgmt() || role() === 'account_manager';

  async function lookup(key, path) {
    if (!state.lookups[key]) state.lookups[key] = get(path);
    try {
      return await state.lookups[key];
    } catch (err) {
      delete state.lookups[key];
      throw err;
    }
  }
  const invalidate = (...keys) => keys.forEach((k) => delete state.lookups[k]);
  const warehouses = () => lookup('warehouses', '/warehouses');
  const clients = () => lookup('clients', '/clients');
  const products = () => lookup('products', '/products');
  const campaigns = () => lookup('campaigns', '/campaigns');

  function navItems() {
    const r = role();
    const items = [{ route: 'dashboard', label: 'Dashboard' }, { route: 'reminders', label: 'Reminders', count: state.counts.reminders }];
    if (r === 'promoter') {
      items.push(
        { route: 'badge', label: 'My ID badge' },
        { route: 'my-stock', label: 'My stock' },
        { route: 'requests', label: 'Stock requests', count: state.counts.to_confirm },
        { route: 'usage', label: 'Activation reports' },
        { route: 'returns', label: 'Returns' },
        { route: 'campaigns', label: 'My campaigns' },
      );
      return items;
    }
    items.push({ group: 'Operations' });
    if (isOps()) items.push({ route: 'counter', label: 'Promoter counter' });
    items.push({
      route: 'requests',
      label: r === 'warehouse' ? 'Dispatch queue' : 'Stock requests',
      count: r === 'warehouse' ? state.counts.to_dispatch : state.counts.pending_approval,
    });
    items.push({ route: 'returns', label: 'Returns', count: r === 'warehouse' ? state.counts.pending_returns : null });
    items.push({ route: 'deliveries', label: 'Deliveries & waybills' }, { route: 'handovers', label: 'Handover log' });
    if (r !== 'warehouse') items.push({ route: 'campaigns', label: 'Campaigns' }, { route: 'usage', label: 'Activation reports' });
    items.push(
      { group: 'Stock' },
      { route: 'stock', label: 'Stock on hand' },
      { route: 'uniforms', label: 'Uniforms' },
      { route: 'expiry', label: 'Expiry dates' },
      { route: 'field', label: 'Stock with promoters' },
    );
    if (isOps()) {
      items.push(
        { route: 'receive', label: 'Receive stock' },
        { route: 'transfer', label: 'Transfer' },
        { route: 'count', label: 'Stock take' },
        { route: 'laundry', label: 'Laundry' },
        { route: 'labels', label: 'QR labels' },
      );
    }
    items.push({ route: 'movements', label: 'Stock ledger' });
    if (r === 'warehouse') items.push({ route: 'campaigns', label: 'Campaigns' });
    items.push({ group: 'Setup' }, { route: 'kits', label: 'Kits & setups' });
    if (isOps()) items.push({ route: 'badges', label: 'Promoter badges' });
    if (r !== 'warehouse') {
      items.push({ route: 'clients', label: 'Clients' });
      if (isMgmt()) items.push({ route: 'warehouses', label: 'Warehouses' });
      if (r === 'director') items.push({ route: 'users', label: 'Staff & users' });
    }
    return items;
  }

  const routes = {};
  let currentMain = null;

  function parseHash() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    return { name: parts[0] || 'dashboard', id: parts.slice(1).join('/') || undefined };
  }
  const go = (path) => {
    if (location.hash === `#/${path}`) render();
    else location.hash = `#/${path}`;
  };

  async function refreshCounts() {
    try {
      const [d, reminders] = await Promise.all([get('/dashboard'), get('/reminders')]);
      state.counts = { ...(d.kpis || {}), reminders: reminders.filter((x) => x.severity !== 'low').length };
      state.lastDashboard = d;
      state.reminders = reminders;
    } catch {
      /* counts are cosmetic */
    }
  }

  /** Scan anything: promoter badge → counter, product → details, request/return → open it. */
  function globalScan() {
    scanner(async (code) => {
      const res = await get(`/scan${qs({ code })}`);
      if (res.kind === 'promoter') go(`counter/${res.promoter.id}`);
      else if (res.kind === 'request') go(`requests/${res.id}`);
      else if (res.kind === 'return') returnDetail(res.id);
      else if (res.kind === 'product') {
        if (res.can_view) productDetail(res.product.id);
        else toast(`${res.product.sku} · ${res.product.name}`);
      }
    });
  }

  function renderShell() {
    const { name } = parseHash();
    const navEl = h('nav', { class: 'nav' });
    for (const item of navItems()) {
      if (item.group !== undefined && !item.route) {
        navEl.append(h('div', { class: 'nav-group' }, item.group));
        continue;
      }
      navEl.append(
        h(
          'a',
          { href: `#/${item.route}`, class: name === item.route ? 'active' : null },
          item.label,
          item.count ? h('span', { class: 'count' }, item.count) : null,
        ),
      );
    }
    const shell = h(
      'div',
      { class: 'shell' },
      h(
        'aside',
        { class: 'sidebar' },
        h('div', { class: 'logo' }, h('div', { class: 'mark' }, 'JR'), h('div', null, 'JR Promotions', h('small', null, 'Stock & logistics'))),
        role() === 'promoter' ? null : h('button', { class: 'scan-btn', onclick: globalScan }, '⌗ Scan QR code'),
        navEl,
        h(
          'div',
          { class: 'me' },
          h('div', null, h('strong', null, state.user.name)),
          h('div', { class: 'muted', style: 'color:#a9cdd4' }, ROLE_NAMES[role()], state.user.region ? ` · ${state.user.region}` : ''),
          h(
            'div',
            { style: 'display:flex;gap:6px;flex-wrap:wrap' },
            h('button', { class: 'ghost small', onclick: changePassword }, 'Password'),
            h('button', { class: 'ghost small', onclick: logout }, 'Sign out'),
          ),
        ),
      ),
      h(
        'div',
        null,
        h(
          'div',
          { class: 'topbar' },
          h('button', { 'aria-label': 'Menu', onclick: () => shell.classList.toggle('nav-open') }, '☰'),
          h('strong', null, 'JR Promotions'),
          role() === 'promoter' ? null : h('button', { style: 'margin-left:auto;font-size:1rem', onclick: globalScan, 'aria-label': 'Scan QR code' }, '⌗ Scan'),
        ),
        (currentMain = h('main', { class: 'main' })),
      ),
    );
    shell.addEventListener('click', (e) => {
      if (e.target.closest('.nav a')) shell.classList.remove('nav-open');
      else if (shell.classList.contains('nav-open') && !e.target.closest('.sidebar') && !e.target.closest('.topbar')) {
        shell.classList.remove('nav-open');
      }
    });
    const app = document.getElementById('app');
    app.replaceChildren(shell);
  }

  let renderSeq = 0;
  async function render() {
    if (!state.user) return renderLogin();
    [...openModals].forEach((close) => close());
    await refreshCounts();
    renderShell();
    const { name, id } = parseHash();
    const view = routes[name] || routes.dashboard;
    const seq = ++renderSeq;
    currentMain.replaceChildren(h('div', { class: 'muted' }, 'Loading…'));
    try {
      const el = await view(id);
      if (seq === renderSeq) currentMain.replaceChildren(el);
    } catch (err) {
      if (seq === renderSeq) currentMain.replaceChildren(h('div', { class: 'card' }, h('h2', null, 'Could not load this page'), h('p', { class: 'muted' }, err.message)));
    }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', render);

  function page(title, actions, ...body) {
    return h('div', null, h('div', { class: 'page-head' }, h('h1', null, title), h('div', { class: 'actions' }, actions)), body);
  }

  // ------------------------------------------------------------------ auth

  function renderLogin() {
    const email = input({ type: 'email', autocomplete: 'username', required: true, placeholder: 'you@jrpromo.co.za' });
    const password = input({ type: 'password', autocomplete: 'current-password', required: true });
    const err = h('div', { class: 'error-text' });
    const submit = h('button', { type: 'submit', style: 'width:100%;margin-top:16px' }, 'Sign in');
    const doLogin = async (e) => {
      if (e) e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        const res = await api('POST', '/auth/login', { email: email.value, password: password.value });
        state.user = res.user;
        state.lookups = {};
        if (!location.hash) location.hash = '#/dashboard';
        render();
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        submit.disabled = false;
      }
    };
    const demo = [
      ['Director', 'director@jrpromo.test'],
      ['Office', 'office@jrpromo.test'],
      ['Account manager', 'lerato@jrpromo.test'],
      ['Warehouse', 'warehouse@jrpromo.test'],
      ['Promoter', 'promoter@jrpromo.test'],
    ];
    document.getElementById('app').replaceChildren(
      h(
        'div',
        { class: 'login' },
        h(
          'form',
          { class: 'card', onsubmit: doLogin },
          h('div', { class: 'logo' }, h('div', { class: 'mark' }, 'JR'), h('div', null, 'JR Promotions', h('small', null, 'Stock & logistics system'))),
          field('Email', email),
          h('div', { style: 'height:12px' }),
          field('Password', password),
          submit,
          err,
          h(
            'div',
            { class: 'demo' },
            h('div', { class: 'small muted' }, 'Demo accounts (password: password123)'),
            h(
              'div',
              { class: 'chips' },
              demo.map(([label, addr]) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'secondary small',
                    onclick: () => {
                      email.value = addr;
                      password.value = 'password123';
                      doLogin();
                    },
                  },
                  label,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  async function logout() {
    await post('/auth/logout').catch(() => {});
    state.user = null;
    state.lookups = {};
    renderLogin();
  }

  function changePassword() {
    const current = input({ type: 'password', autocomplete: 'current-password' });
    const next = input({ type: 'password', autocomplete: 'new-password', minlength: '8' });
    const save = h('button', null, 'Change password');
    const m = modal('Change password', h('div', { class: 'form-grid' }, field('Current password', current), field('New password', next, { hint: 'At least 8 characters' })), [save]);
    save.onclick = () =>
      busy(save, async () => {
        await post('/auth/password', { current: current.value, next: next.value });
        m.close();
        toast('Password changed', 'ok');
      });
  }

  // ------------------------------------------------------------------ dashboard

  function kpi(label, value, { alert, href } = {}) {
    const inner = [h('div', { class: 'label' }, label), h('div', { class: 'value' }, value)];
    return h('div', { class: `kpi${alert ? ' alert' : ''}` }, href ? h('a', { href }, inner) : inner);
  }

  function bars(rows, { label, value, format }) {
    const max = Math.max(1, ...rows.map(value));
    return h(
      'div',
      { class: 'bars' },
      rows.map((r) =>
        h(
          'div',
          { class: 'bar-row' },
          h('div', { class: 'nowrap', style: 'overflow:hidden;text-overflow:ellipsis' }, label(r)),
          h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: `width:${(value(r) / max) * 100}%` })),
          h('div', { class: 'right' }, format(value(r))),
        ),
      ),
    );
  }

  function flowChart(flow, since) {
    const days = [];
    const start = parseDate(since);
    const byDay = new Map(flow.map((f) => [f.day, f]));
    for (let i = 0; i < 30; i++) {
      const d = new Date(start.getTime() + i * 864e5);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      days.push({ key, ...(byDay.get(key) || { inbound: 0, dispatched: 0, used: 0 }) });
    }
    const series = [
      ['inbound', '#1f8a4c', 'Received / returned'],
      ['dispatched', '#16697a', 'Dispatched to promoters'],
      ['used', '#ffb84d', 'Used in field'],
    ];
    const max = Math.max(1, ...days.flatMap((d) => series.map(([k]) => d[k])));
    const W = 600;
    const H = 150;
    const slot = W / days.length;
    const bw = (slot - 2) / 3;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Daily stock flow, last 30 days');
    days.forEach((d, i) => {
      series.forEach(([k, color], j) => {
        const v = d[k];
        if (!v) return;
        const bh = Math.max(1, (v / max) * (H - 4));
        const rect = document.createElementNS(ns, 'rect');
        rect.setAttribute('x', i * slot + 1 + j * bw);
        rect.setAttribute('y', H - bh);
        rect.setAttribute('width', bw);
        rect.setAttribute('height', bh);
        rect.setAttribute('fill', color);
        rect.setAttribute('rx', 1);
        const t = document.createElementNS(ns, 'title');
        t.textContent = `${fmtDate(d.key)}: ${num(v)} ${k}`;
        rect.append(t);
        svg.append(rect);
      });
    });
    return h(
      'div',
      { class: 'flow' },
      svg,
      h(
        'div',
        { class: 'legend' },
        series.map(([, color, label]) => h('span', null, h('i', { style: `background:${color}` }), label)),
        h('span', { style: 'margin-left:auto' }, `${fmtDate(days[0].key)} – ${fmtDate(days[days.length - 1].key)}`),
      ),
    );
  }

  routes.dashboard = async () => {
    const d = state.lastDashboard || (await get('/dashboard'));
    if (d.role === 'promoter') return promoterDashboard(d);
    const k = d.kpis;
    const r = role();
    const kpis = h(
      'div',
      { class: 'kpis' },
      k.stock_value !== undefined ? kpi('Stock value (warehouses)', money(k.stock_value)) : null,
      kpi('Units on hand', num(k.units_on_hand)),
      kpi('Units with promoters', num(k.units_in_field)),
      k.field_value !== undefined ? kpi('Value with promoters', money(k.field_value)) : null,
      kpi('Below reorder level', num(k.low_stock), { alert: k.low_stock > 0, href: '#/stock' }),
      r !== 'warehouse' ? kpi('Awaiting approval', num(k.pending_approval), { alert: k.pending_approval > 0, href: '#/requests' }) : null,
      kpi('To pick & dispatch', num(k.to_dispatch), { href: '#/requests' }),
      kpi('Returns to check in', num(k.pending_returns), { href: '#/returns' }),
      kpi('Active campaigns', num(k.active_campaigns), { href: r === 'warehouse' ? null : '#/campaigns' }),
    );

    const work =
      r === 'warehouse'
        ? h(
            'div',
            { class: 'card' },
            h('h2', null, 'Dispatch queue'),
            table(
              [
                { label: 'Ref', render: (x) => h('span', { class: 'mono' }, x.ref) },
                { label: 'Promoter', key: 'promoter_name' },
                { label: 'From', key: 'warehouse_name' },
                { label: 'Needed by', render: (x) => fmtDate(x.needed_by) },
                { label: 'Units', num: true, render: (x) => num(x.units) },
                { label: 'Status', render: (x) => badge(x.status) },
              ],
              d.queue,
              { onRow: (x) => go(`requests/${x.id}`), empty: 'Nothing waiting to be dispatched' },
            ),
          )
        : h(
            'div',
            { class: 'card' },
            h('h2', null, 'Requests awaiting approval'),
            table(
              [
                { label: 'Ref', render: (x) => h('span', { class: 'mono' }, x.ref) },
                { label: 'Campaign', key: 'campaign_name' },
                { label: 'Promoter', key: 'promoter_name' },
                { label: 'Needed by', render: (x) => fmtDate(x.needed_by) },
              ],
              d.awaiting_approval,
              { onRow: (x) => go(`requests/${x.id}`), empty: 'No requests waiting for approval' },
            ),
          );

    const low = h(
      'div',
      { class: 'card' },
      h('h2', null, 'Low stock'),
      table(
        [
          { label: 'SKU', render: (x) => h('span', { class: 'mono' }, x.sku) },
          { label: 'Product', key: 'name' },
          { label: 'Client', key: 'client_name' },
          { label: 'On hand', num: true, render: (x) => num(x.on_hand) },
          { label: 'Reorder at', num: true, render: (x) => num(x.reorder_level) },
        ],
        d.low_stock,
        { onRow: canSeeStock() ? (x) => productDetail(x.id) : null, empty: 'All products are above their reorder levels' },
      ),
    );

    const showValue = d.by_warehouse.length && d.by_warehouse[0].value !== undefined;
    const byWarehouse = h(
      'div',
      { class: 'card' },
      h('h2', null, 'Stock by warehouse'),
      bars(d.by_warehouse, {
        label: (x) => x.name,
        value: (x) => (showValue ? x.value : x.units),
        format: showValue ? money : (n) => `${num(n)} units`,
      }),
    );
    const byClient = d.by_client
      ? h(
          'div',
          { class: 'card' },
          h('h2', null, 'Stock value by client'),
          bars(d.by_client, { label: (x) => x.name, value: (x) => x.value, format: money }),
        )
      : null;

    const recent = h(
      'div',
      { class: 'card' },
      h('h2', null, 'Recent stock movements'),
      table(
        [
          { label: 'When', render: (x) => fmtDateTime(x.created_at), class: 'nowrap' },
          { label: 'Type', render: (x) => badge(x.type, MOVEMENT_NAMES[x.type]) },
          { label: 'Product', render: (x) => `${x.sku} · ${x.product_name}` },
          { label: 'Qty', num: true, render: (x) => num(x.qty) },
          { label: 'Ref', render: (x) => h('span', { class: 'mono' }, x.reference || '') },
        ],
        d.recent,
      ),
    );

    return page(
      `Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${state.user.name.split(' ')[0]}`,
      [
        isOps() ? h('a', { class: 'btn', href: '#/receive' }, 'Receive stock') : null,
        isOps() ? h('a', { class: 'btn secondary', href: '#/counter' }, 'Promoter counter') : null,
        r === 'account_manager' || isMgmt() ? h('button', { class: 'secondary', onclick: () => requestForm() }, 'New stock request') : null,
      ],
      kpis,
      h('div', { class: 'card' }, h('div', { class: 'page-head', style: 'margin-bottom:8px' }, h('h2', { style: 'margin:0' }, 'Reminders'), h('a', { href: '#/reminders', class: 'small' }, 'See all →')), reminderList(state.reminders || [], { limit: 6 })),
      h('div', { class: 'card' }, h('h2', null, 'Stock flow · last 30 days'), flowChart(d.flow, d.flow_since)),
      h('div', { class: 'grid two', style: 'margin-top:16px' }, work, low),
      h('div', { class: 'grid two', style: 'margin-top:16px' }, byWarehouse, byClient || recent),
      byClient ? h('div', { style: 'margin-top:16px' }, recent) : null,
    );
  };

  function promoterDashboard(d) {
    const k = d.kpis;
    const toConfirm = d.requests.filter((r) => r.status === 'dispatched');
    return page(
      `Hi ${state.user.name.split(' ')[0]}`,
      [
        h('button', { onclick: () => requestForm() }, 'Request stock'),
        h('button', { class: 'secondary', onclick: () => usageForm() }, 'Log activation'),
      ],
      h(
        'div',
        { class: 'kpis' },
        kpi('Units I hold', num(k.units_held), { href: '#/my-stock' }),
        kpi('Active campaigns', num(k.active_campaigns), { href: '#/campaigns' }),
        kpi('Open requests', num(k.open_requests), { href: '#/requests' }),
        kpi('Deliveries to confirm', num(k.to_confirm), { alert: k.to_confirm > 0 }),
      ),
      (state.reminders || []).length ? h('div', { class: 'card' }, h('div', { class: 'page-head', style: 'margin-bottom:8px' }, h('h2', { style: 'margin:0' }, 'Reminders'), h('a', { href: '#/reminders', class: 'small' }, 'See all →')), reminderList(state.reminders || [], { limit: 6 })) : null,
      toConfirm.length
        ? h(
            'div',
            { class: 'card' },
            h('h2', null, 'Stock on its way to you'),
            h('p', { class: 'muted small' }, 'Confirm once you have received and checked the stock.'),
            h(
              'div',
              { class: 'list' },
              toConfirm.map((r) =>
                h(
                  'div',
                  { class: 'list-item' },
                  h(
                    'div',
                    null,
                    h('strong', { class: 'mono' }, r.ref),
                    ' · ',
                    r.campaign_name,
                    h('div', { class: 'small muted' }, r.waybill ? `${r.courier || 'Courier'} waybill ${r.waybill}` : 'Collect / JR vehicle'),
                  ),
                  h('div', { style: 'display:flex;gap:6px' },
                    h('button', { class: 'secondary small', onclick: () => go(`requests/${r.id}`) }, 'View'),
                    h('button', { class: 'ok small', onclick: () => confirmDelivery(r, render) }, 'Received')),
                ),
              ),
            ),
          )
        : null,
      h(
        'div',
        { class: 'grid two', style: 'margin-top:16px' },
        h('div', { class: 'card' }, h('h2', null, 'Stock I am holding'), holdingTable(d.holding)),
        h(
          'div',
          { class: 'card' },
          h('h2', null, 'My campaigns'),
          d.campaigns.length
            ? h(
                'div',
                { class: 'list' },
                d.campaigns.map((c) =>
                  h(
                    'div',
                    { class: 'list-item clickable', onclick: () => go(`campaigns/${c.id}`) },
                    h('div', null, h('strong', null, c.name), h('div', { class: 'small muted' }, `${c.client_name} · ${fmtDate(c.start_date)} – ${fmtDate(c.end_date)}`)),
                    badge(c.status),
                  ),
                ),
              )
            : h('div', { class: 'empty' }, 'You are not on any campaigns yet'),
        ),
      ),
    );
  }

  function holdingTable(rows) {
    return table(
      [
        { label: 'Campaign', key: 'campaign_name' },
        { label: 'Product', render: (x) => h('div', null, x.product_name, h('div', { class: 'small muted mono' }, x.sku)) },
        { label: 'Qty', num: true, render: (x) => `${num(x.qty)} ${x.unit === 'unit' ? '' : x.unit}` },
      ],
      rows,
      { empty: 'You are not holding any stock' },
    );
  }

  routes['my-stock'] = async () => {
    const rows = await get('/stock/mine');
    return page(
      'My stock',
      [
        h('button', { onclick: () => usageForm() }, 'Log activation'),
        h('button', { class: 'secondary', onclick: () => returnForm() }, 'Return stock'),
      ],
      h('div', { class: 'card' }, h('p', { class: 'muted small', style: 'margin-top:0' }, 'Stock dispatched to you, less what you have reported as used or returned.'), holdingTable(rows)),
    );
  };

  // ------------------------------------------------------------------ stock on hand & products

  routes.stock = async () => {
    const [cls, cats, whs] = await Promise.all([clients(), get('/products/categories'), warehouses()]);
    const filters = { q: '', client_id: '', category: '', low: '', expiring: '' };
    const search = input({ type: 'search', placeholder: 'Search SKU, name or barcode…' });
    const clientSel = select(cls.map((c) => ({ value: c.id, label: c.name })), {}, 'All clients');
    const catSel = select(cats.map((c) => ({ value: c, label: c })), {}, 'All categories');
    const lowBox = input({ type: 'checkbox' });
    const expBox = input({ type: 'checkbox' });
    const out = h('div');
    const activeWh = whs.filter((w) => w.active);

    const load = async () => {
      Object.assign(filters, { q: search.value, client_id: clientSel.value, category: catSel.value, low: lowBox.checked ? '1' : '', expiring: expBox.checked ? '1' : '' });
      const rows = await get(`/products${qs(filters)}`);
      const cols = [
        { label: 'SKU', render: (x) => h('span', { class: 'mono' }, x.sku) },
        { label: 'Product', render: (x) => h('div', null, x.name, h('div', { class: 'small muted' }, `${x.client_name} · ${x.category}`)) },
        {
          label: 'Expiry',
          render: (x) =>
            !x.tracks_expiry
              ? h('span', { class: 'muted' }, '—')
              : h('div', { class: 'small nowrap' }, x.expired ? badge('rejected', `${num(x.expired)} expired`) : null, x.next_expiry ? h('div', null, `next ${fmtDate(x.next_expiry)}`) : null),
        },
        ...activeWh.map((w) => ({
          label: w.name,
          num: true,
          render: (x) => {
            const l = x.levels.find((lv) => lv.warehouse_id === w.id);
            return l ? num(l.qty) : h('span', { class: 'muted' }, '0');
          },
        })),
        { label: 'Allocated', num: true, render: (x) => (x.allocated ? num(x.allocated) : h('span', { class: 'muted' }, '0')) },
        { label: 'Available', num: true, render: (x) => h('strong', null, num(x.available)) },
        { label: 'With promoters', num: true, render: (x) => num(x.in_field) },
        { label: 'At laundry', num: true, render: (x) => (x.in_laundry ? num(x.in_laundry) : h('span', { class: 'muted' }, '—')) },
        { label: 'Reorder at', num: true, render: (x) => num(x.reorder_level) },
      ];
      if (canSeeCost()) cols.push({ label: 'Value', num: true, render: (x) => money(x.on_hand * x.unit_cost) });
      const totalValue = rows.reduce((s, x) => s + x.on_hand * x.unit_cost, 0);
      out.replaceChildren(
        h('div', { class: 'small muted', style: 'margin-bottom:8px' }, `${rows.length} products · ${num(rows.reduce((s, x) => s + x.on_hand, 0))} units on hand`, canSeeCost() ? ` · ${money(totalValue)}` : ''),
        table(cols, rows, {
          onRow: (x) => productDetail(x.id),
          rowClass: (x) => (x.reorder_level && x.on_hand <= x.reorder_level ? 'low' : ''),
          empty: 'No products match',
        }),
      );
    };
    let t;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(load, 250);
    });
    [clientSel, catSel, lowBox, expBox].forEach((el) => el.addEventListener('change', load));
    await load();

    return page(
      'Stock on hand',
      [
        h('a', { class: 'btn secondary', href: `/api/stock/levels.csv`, onclick: (e) => { e.currentTarget.href = `/api/stock/levels.csv${qs(filters)}`; } }, 'Export CSV'),
        isMgmt() || role() === 'account_manager' ? h('button', { class: 'secondary', onclick: () => rangeForm(load) }, 'New uniform range') : null,
        isMgmt() || role() === 'account_manager' ? h('button', { onclick: () => productForm(null, load) }, 'New product') : null,
      ],
      h('div', { class: 'card' }, h('div', { class: 'filters' }, search, clientSel, catSel, h('label', { class: 'check' }, lowBox, 'Low stock only'), h('label', { class: 'check' }, expBox, 'Expiring / expired')), out),
    );
  };

  async function productDetail(id) {
    const p = await busy(null, () => get(`/products/${id}`));
    if (!p) return;
    const canEdit = isMgmt() || (role() === 'account_manager' && !p.is_house);
    const variants = p.variants.length > 1 ? variantGrid(p) : null;
    const body = h(
      'div',
      null,
      h(
        'div',
        { class: 'product-head' },
        h(
          'dl',
          { class: 'dl' },
          h('dt', null, 'SKU'), h('dd', { class: 'mono' }, p.sku),
          h('dt', null, 'Client'), h('dd', null, p.client_name),
          h('dt', null, 'Category'), h('dd', null, p.category),
          p.size ? [h('dt', null, 'Variant'), h('dd', null, [GENDER_NAMES[p.gender], p.colour, p.size].filter(Boolean).join(' · '))] : null,
          h('dt', null, 'Unit'), h('dd', null, p.unit),
          p.barcode ? [h('dt', null, 'Barcode'), h('dd', { class: 'mono' }, p.barcode)] : null,
          canSeeCost() ? [h('dt', null, 'Unit cost'), h('dd', null, money(p.unit_cost))] : null,
          h('dt', null, 'Reorder level'), h('dd', null, num(p.reorder_level)),
          h('dt', null, 'On hand'), h('dd', null, `${num(p.on_hand)} (${num(p.allocated)} allocated, ${num(p.available)} free)`),
          p.tracks_expiry ? [h('dt', null, 'Expiry'), h('dd', null, p.expired ? badge('rejected', `${num(p.expired)} expired`) : null, ' ', p.next_expiry ? `next batch expires ${fmtDate(p.next_expiry)}` : '')] : null,
          p.in_laundry ? [h('dt', null, 'At laundry'), h('dd', null, num(p.in_laundry))] : null,
        ),
        h('div', { class: 'qr-box' }, qrImg(`JRP:${p.sku}`, 110), h('div', { class: 'small muted' }, 'Product QR')),
      ),
      variants ? [h('h3', { style: 'margin-top:18px' }, 'Sizes & colours in this range'), variants] : null,
      h('h3', { style: 'margin-top:18px' }, 'Warehouse levels'),
      table(
        [
          { label: 'Warehouse', key: 'warehouse_name' },
          { label: 'Bin', render: (x) => x.bin || '—' },
          { label: 'Qty', num: true, render: (x) => num(x.qty) },
          p.category === 'Uniform' ? { label: 'At laundry', num: true, render: (x) => num(x.laundry) } : null,
        ].filter(Boolean),
        p.levels,
        { empty: 'Not stocked in any warehouse' },
      ),
      p.tracks_expiry
        ? [
            h('h3', { style: 'margin-top:18px' }, 'Batches (first to expire goes out first)'),
            table(
              [
                { label: 'Warehouse', key: 'warehouse_name' },
                { label: 'Batch', render: (x) => h('span', { class: 'mono small' }, x.batch_no) },
                { label: 'Expires', render: (x) => (x.expiry_date ? fmtDate(x.expiry_date) : '—') },
                { label: 'Qty', num: true, render: (x) => num(x.qty) },
              ],
              p.batches,
              { empty: 'No batches in stock', rowClass: (x) => (x.expiry_date && x.expiry_date < today() ? 'low' : '') },
            ),
          ]
        : null,
      h('h3', { style: 'margin-top:18px' }, 'With promoters'),
      table(
        [
          { label: 'Promoter', key: 'promoter_name' },
          { label: 'Campaign', key: 'campaign_name' },
          { label: 'Qty', num: true, render: (x) => num(x.qty) },
        ],
        p.field,
        { empty: 'None out in the field' },
      ),
      h('h3', { style: 'margin-top:18px' }, 'Recent movements'),
      movementTable(p.movements, { compact: true }),
    );
    const m = modal(p.name, body, [
      isOps() ? h('a', { class: 'btn secondary', href: '#/labels' }, 'Print QR labels') : null,
      canEdit ? h('button', { class: 'secondary', onclick: () => { m.close(); productForm(p, () => render()); } }, 'Edit product') : null,
      h('button', { onclick: () => m.close() }, 'Close'),
    ].filter(Boolean), { wide: true });
  }

  function variantGrid(p) {
    const sizes = [...new Set(p.variants.map((v) => v.size || '—'))].sort((a, b) => sizeOrder(a) - sizeOrder(b));
    const cols = [...new Set(p.variants.map((v) => `${GENDER_NAMES[v.gender] || ''} ${v.colour || ''}`.trim()))].sort();
    return h('div', { class: 'table-wrap' }, h('table', { class: 'matrix' },
      h('thead', null, h('tr', null, h('th', null, 'Size'), cols.map((c) => h('th', { class: 'num' }, c)))),
      h('tbody', null, sizes.map((size) => h('tr', null, h('th', null, size), cols.map((c) => {
        const v = p.variants.find((x) => (x.size || '—') === size && `${GENDER_NAMES[x.gender] || ''} ${x.colour || ''}`.trim() === c);
        return h('td', { class: `num${v && v.id === p.id ? ' current' : ''}` }, v ? num(v.on_hand) : '—');
      })))),
    ));
  }

  async function productForm(p, done) {
    const [cls, cats] = await Promise.all([clients(), get('/products/categories')]);
    const mine = role() === 'account_manager' ? cls.filter((c) => c.account_manager_id === state.user.id) : cls;
    const f = {
      sku: input({ value: p ? p.sku : '', maxlength: '40', placeholder: 'e.g. SFJ-SMP-200' }),
      name: input({ value: p ? p.name : '' }),
      client_id: select(mine.map((c) => ({ value: c.id, label: c.name })), { value: p ? p.client_id : '' }, 'Choose client…'),
      category: select(cats.map((c) => ({ value: c, label: c })), { value: p ? p.category : '' }, 'Choose…'),
      unit: input({ value: p ? p.unit : 'unit', placeholder: 'unit, box, sleeve…' }),
      unit_cost: input({ type: 'number', step: '0.01', min: '0', value: p ? p.unit_cost : '' }),
      reorder_level: input({ type: 'number', min: '0', step: '1', value: p ? p.reorder_level : '' }),
      barcode: input({ value: p ? p.barcode || '' : '', inputmode: 'numeric' }),
      style: input({ value: p ? p.style || '' : '', placeholder: 'Groups sizes/colours, e.g. JR promoter golf shirt' }),
      gender: select(Object.entries(GENDER_NAMES).map(([value, label]) => ({ value, label })), { value: p ? p.gender || '' : '' }, '—'),
      size: select(['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'].map((x) => ({ value: x, label: x })), { value: p ? p.size || '' : '' }, '—'),
      colour: input({ value: p ? p.colour || '' : '', placeholder: 'e.g. Black' }),
      tracks_expiry: input({ type: 'checkbox', checked: p ? !!p.tracks_expiry : false }),
      active: input({ type: 'checkbox', checked: p ? !!p.active : true }),
    };
    const uniformFields = h('div', { class: 'form-grid field full uniform-fields' }, field('Cut', f.gender), field('Size', f.size), field('Colour', f.colour), field('Style / range', f.style));
    const syncCategory = () => (uniformFields.hidden = f.category.value !== 'Uniform');
    f.category.addEventListener('change', syncCategory);
    syncCategory();
    const save = h('button', null, p ? 'Save changes' : 'Create product');
    const m = modal(
      p ? `Edit ${p.sku}` : 'New product',
      h(
        'div',
        { class: 'form-grid' },
        field('SKU', f.sku),
        field('Name', f.name),
        field('Client', f.client_id, { hint: 'JR Promotions (company stock) = tables, setups and uniforms any campaign can use' }),
        field('Category', f.category),
        uniformFields,
        field('Unit of measure', f.unit),
        field('Unit cost (R)', f.unit_cost, { hint: 'Used for stock valuation' }),
        field('Reorder level', f.reorder_level, { hint: 'Alert when total on hand drops to this' }),
        field('Barcode', f.barcode),
        h('label', { class: 'check field full' }, f.tracks_expiry, 'Has an expiry date (track batches)'),
        h('label', { class: 'check field full' }, f.active, 'Active'),
      ),
      [save],
    );
    save.onclick = () =>
      busy(save, async () => {
        const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
        if (p) await put(`/products/${p.id}`, body);
        else await post('/products', body);
        invalidate('products');
        m.close();
        toast(p ? 'Product updated' : 'Product created', 'ok');
        if (done) done();
      });
  }

  // ------------------------------------------------------------------ receive / transfer / stock take

  function productOptions(list, hint) {
    return list.map((p) => ({ id: p.id, label: `${p.sku} · ${p.name}`, group: p.client_name, hint: hint ? hint(p) : '', tracksExpiry: !!p.tracks_expiry }));
  }

  routes.receive = async () => {
    const [whs, prods] = await Promise.all([warehouses(), products()]);
    const wh = select(whs.filter((w) => w.active).map((w) => ({ value: w.id, label: `${w.name} (${w.city})` })), { value: state.user.warehouse_id || '' }, 'Choose warehouse…');
    const ref = input({ placeholder: 'Waybill / delivery note / GRN number', maxlength: '80' });
    const note = input({ placeholder: 'Supplier, courier, condition, etc.' });
    const lines = linesEditor(productOptions(prods), { withBin: true, withBatch: true });
    const photos = [];
    const photoList = h('div', { class: 'hint' }, 'No photos added yet');
    const picker = filePicker((files) => {
      photos.push(...files);
      photoList.textContent = photos.map((f) => f.name).join(', ');
    }, { label: 'Photo of waybill' });
    const scanBtn = h('button', { type: 'button', class: 'secondary small', onclick: () => scanner((code) => {
      const sku = skuFromCode(code);
      const p = prods.find((x) => x.sku.toUpperCase() === sku || x.barcode === code);
      if (!p || !lines.add({ product_id: p.id, qty: 1 })) throw new Error(`✗ ${sku} is not a known product`);
      return `✓ Added 1 × ${p.sku}`;
    }, { title: 'Scan items in', keepOpen: true, help: 'Each scan adds one unit. Type a quantity afterwards for full boxes.' }) }, '⌗ Scan items');
    const save = h('button', null, 'Book stock in');
    save.onclick = () =>
      busy(save, async () => {
        const res = await post('/stock/receive', { warehouse_id: wh.value, reference: ref.value, note: note.value, items: lines.values() });
        invalidate('products', 'warehouses');
        if (photos.length) {
          try {
            await uploadFiles({ kind: 'receipt', reference: res.reference, warehouse_id: Number(wh.value) }, photos, 'Waybill / delivery note');
          } catch (err) {
            toast(`Stock booked in, but a photo failed to upload: ${err.message}`, 'error');
          }
        }
        toast('Stock received', 'ok');
        go(`deliveries/${wh.value}~${encodeURIComponent(res.reference)}`);
      });
    return page(
      'Receive stock',
      null,
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'muted small', style: 'margin-top:0' }, 'Book client or supplier deliveries into a warehouse. Dated stock (samples etc.) needs a batch and expiry date.'),
        h('div', { class: 'form-grid' }, field('Warehouse', wh), field('Reference', ref), field('Note', note, { full: true })),
        h('div', { class: 'page-head', style: 'margin:18px 0 8px' }, h('h3', { style: 'margin:0' }, 'Products received'), scanBtn),
        lines.el,
        h('h3', { style: 'margin-top:18px' }, 'Waybill & delivery photos'),
        h('p', { class: 'hint', style: 'margin-top:-4px' }, 'Snap the signed waybill or delivery note. You can add more later under Deliveries & waybills.'),
        picker,
        photoList,
        h('div', { style: 'margin-top:18px' }, save),
      ),
    );
  };

  routes.transfer = async () => {
    const [whs, prods] = await Promise.all([warehouses(), products()]);
    const opts = whs.filter((w) => w.active).map((w) => ({ value: w.id, label: `${w.name} (${w.city})` }));
    const from = select(opts, { value: state.user.warehouse_id || '' }, 'From…');
    const to = select(opts, {}, 'To…');
    const ref = input({ placeholder: 'Optional, generated if blank', maxlength: '80' });
    const note = input({ placeholder: 'e.g. Truck, driver, reason' });
    const lines = linesEditor(productOptions(prods, (p) => levelHint(p, from.value)));
    from.addEventListener('change', () => lines.el.refreshHints((p) => levelHint(p, from.value)));
    const save = h('button', null, 'Transfer stock');
    save.onclick = () =>
      busy(save, async () => {
        const r = await post('/stock/transfer', { from_warehouse_id: from.value, to_warehouse_id: to.value, reference: ref.value, note: note.value, items: lines.values() });
        invalidate('products', 'warehouses');
        toast(`Transfer ${r.reference} booked`, 'ok');
        go('movements');
      });
    return page(
      'Transfer between warehouses',
      null,
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'form-grid' }, field('From warehouse', from), field('To warehouse', to), field('Reference', ref), field('Note', note)),
        h('h3', { style: 'margin-top:18px' }, 'Products'),
        lines.el,
        h('div', { style: 'margin-top:18px' }, save),
      ),
    );
  };

  function levelHint(p, warehouseId) {
    if (!warehouseId) return '';
    const l = p.levels.find((x) => String(x.warehouse_id) === String(warehouseId));
    return `${num(l ? l.qty : 0)} on hand here${l && l.bin ? ` · bin ${l.bin}` : ''}`;
  }

  routes.count = async () => {
    const [whs, cls] = await Promise.all([warehouses(), clients()]);
    const wh = select(whs.filter((w) => w.active).map((w) => ({ value: w.id, label: w.name })), { value: state.user.warehouse_id || '' }, 'Choose warehouse…');
    const cl = select(cls.map((c) => ({ value: c.id, label: c.name })), {}, 'All clients');
    const note = input({ placeholder: 'e.g. Month-end count October' });
    const out = h('div');
    const counted = new Map();
    const load = async () => {
      counted.clear();
      if (!wh.value) return out.replaceChildren(h('div', { class: 'empty' }, 'Choose a warehouse to start counting'));
      invalidate('products');
      const rows = (await get(`/products${qs({ client_id: cl.value })}`));
      out.replaceChildren(
        table(
          [
            { label: 'SKU', render: (x) => h('span', { class: 'mono' }, x.sku) },
            { label: 'Product', render: (x) => h('div', null, x.name, h('div', { class: 'small muted' }, x.client_name)) },
            { label: 'Bin', render: (x) => (x.levels.find((l) => String(l.warehouse_id) === wh.value) || {}).bin || '—' },
            { label: 'System qty', num: true, render: (x) => num((x.levels.find((l) => String(l.warehouse_id) === wh.value) || {}).qty || 0) },
            {
              label: 'Counted',
              num: true,
              render: (x) => {
                const el = input({ type: 'number', min: '0', step: '1', style: 'width:110px', inputmode: 'numeric' });
                el.addEventListener('input', () => (el.value === '' ? counted.delete(x.id) : counted.set(x.id, el.value)));
                return el;
              },
            },
          ],
          rows,
        ),
      );
    };
    wh.addEventListener('change', load);
    cl.addEventListener('change', load);
    await load();
    const save = h('button', null, 'Post stock take');
    save.onclick = () =>
      busy(save, async () => {
        if (!counted.size) throw new Error('Enter at least one counted quantity');
        const r = await post('/stock/count', { warehouse_id: wh.value, note: note.value, items: [...counted].map(([product_id, c]) => ({ product_id, counted: c })) });
        const changed = r.variances.filter((v) => v.variance !== 0);
        toast(changed.length ? `${changed.length} variance(s) posted to the ledger` : 'Count matches the system, no adjustments needed', 'ok');
        invalidate('products', 'warehouses');
        load();
      });
    return page(
      'Stock take',
      null,
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'muted small', style: 'margin-top:0' }, 'Enter physical counts. Only lines you fill in are posted; differences are recorded as adjustments on the ledger.'),
        h('div', { class: 'filters' }, wh, cl, note),
        out,
        h('div', { style: 'margin-top:16px' }, save),
      ),
    );
  };

  // ------------------------------------------------------------------ field stock & ledger

  routes.field = async () => {
    const rows = await get('/stock/field');
    const cols = [
      { label: 'Promoter', render: (x) => h('div', null, x.promoter_name, h('div', { class: 'small muted' }, x.region || '')) },
      { label: 'Campaign', render: (x) => h('div', null, x.campaign_name, ' ', x.campaign_status === 'active' ? null : badge(x.campaign_status)) },
      { label: 'Product', render: (x) => h('div', null, x.product_name, h('div', { class: 'small muted mono' }, x.sku)) },
      { label: 'Qty', num: true, render: (x) => num(x.qty) },
    ];
    if (canSeeCost()) cols.push({ label: 'Value', num: true, render: (x) => money(x.qty * x.unit_cost) });
    const overdue = rows.filter((x) => ['completed', 'cancelled'].includes(x.campaign_status));
    return page(
      'Stock with promoters',
      null,
      overdue.length
        ? h('div', { class: 'card', style: 'border-color:#f0c27a;background:#fffaf0' }, h('strong', null, `${num(overdue.reduce((s, x) => s + x.qty, 0))} units`), ' are still with promoters on campaigns that have ended. Follow up on returns.')
        : null,
      h('div', { class: 'card' }, table(cols, rows, { empty: 'No stock is out with promoters', rowClass: (x) => (x.campaign_status === 'completed' ? 'low' : '') })),
    );
  };

  function movementTable(rows, { compact } = {}) {
    const cols = [
      { label: 'When', render: (x) => fmtDateTime(x.created_at), class: 'nowrap' },
      { label: 'Type', render: (x) => badge(x.type, MOVEMENT_NAMES[x.type]) },
      compact ? null : { label: 'Product', render: (x) => h('div', null, x.product_name, h('div', { class: 'small muted mono' }, x.sku)) },
      { label: 'Qty', num: true, render: (x) => (x.qty > 0 && x.type === 'adjustment' ? `+${num(x.qty)}` : num(x.qty)) },
      {
        label: 'From → to',
        render: (x) => {
          const from = x.from_warehouse || (['usage', 'damage', 'return'].includes(x.type) ? x.promoter_name : null);
          const to = x.to_warehouse || (x.type === 'dispatch' ? x.promoter_name : null);
          return h('span', { class: 'small' }, [from, to].filter(Boolean).join(' → ') || '—');
        },
      },
      { label: 'Ref', render: (x) => h('span', { class: 'mono small' }, x.reference || '') },
      compact ? null : { label: 'By', render: (x) => h('span', { class: 'small' }, x.user_name) },
    ].filter(Boolean);
    return table(cols, rows, { empty: 'No movements' });
  }

  routes.movements = async () => {
    const [whs, cls] = await Promise.all([warehouses(), clients()]);
    const f = {
      type: select(Object.entries(MOVEMENT_NAMES).map(([value, label]) => ({ value, label })), {}, 'All types'),
      warehouse_id: select(whs.map((w) => ({ value: w.id, label: w.name })), {}, 'All warehouses'),
      client_id: select(cls.map((c) => ({ value: c.id, label: c.name })), {}, 'All clients'),
      from: input({ type: 'date', title: 'From date' }),
      to: input({ type: 'date', title: 'To date' }),
    };
    const out = h('div');
    const params = () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
    const load = async () => out.replaceChildren(movementTable(await get(`/stock/movements${qs({ ...params(), limit: 300 })}`)));
    Object.values(f).forEach((el) => el.addEventListener('change', load));
    await load();
    return page(
      'Stock ledger',
      [h('a', { class: 'btn secondary', href: '/api/stock/movements.csv', onclick: (e) => { e.currentTarget.href = `/api/stock/movements.csv${qs(params())}`; } }, 'Export CSV')],
      h('div', { class: 'card' }, h('p', { class: 'muted small', style: 'margin-top:0' }, 'Every stock change is recorded here and cannot be edited. Showing the latest 300; export for the full history.'), h('div', { class: 'filters' }, Object.values(f)), out),
    );
  };

  // ------------------------------------------------------------------ requests

  const REQUEST_TABS = {
    open: { label: 'Open', status: 'pending,approved,picking,dispatched' },
    pending: { label: 'Awaiting approval', status: 'pending' },
    ready: { label: 'To pick / dispatch', status: 'approved,picking' },
    dispatched: { label: 'In transit', status: 'dispatched' },
    closed: { label: 'Closed', status: 'delivered,rejected,cancelled' },
    all: { label: 'All', status: '' },
  };

  routes.requests = async (id) => {
    if (id) return requestDetail(id);
    const r = role();
    let tab = r === 'warehouse' ? 'ready' : r === 'promoter' ? 'open' : 'pending';
    const whs = await warehouses();
    const whSel = select(whs.map((w) => ({ value: w.id, label: w.name })), { value: r === 'warehouse' ? state.user.warehouse_id || '' : '' }, 'All warehouses');
    const tabs = h('div', { class: 'tabs' });
    const out = h('div');
    const load = async () => {
      tabs.replaceChildren(
        ...Object.entries(REQUEST_TABS).map(([key, t]) =>
          h('button', { class: key === tab ? 'active' : null, onclick: () => { tab = key; load(); } }, t.label),
        ),
      );
      const rows = await get(`/requests${qs({ status: REQUEST_TABS[tab].status, warehouse_id: whSel.value })}`);
      out.replaceChildren(
        table(
          [
            { label: 'Ref', render: (x) => h('span', { class: 'mono' }, x.ref) },
            { label: 'Campaign', render: (x) => h('div', null, x.campaign_name, h('div', { class: 'small muted' }, x.client_name)) },
            r === 'promoter' ? null : { label: 'Promoter', key: 'promoter_name' },
            { label: 'Warehouse', key: 'warehouse_name' },
            { label: 'Needed by', render: (x) => fmtDate(x.needed_by), class: 'nowrap' },
            { label: 'Units', num: true, render: (x) => num(x.units) },
            { label: 'Status', render: (x) => badge(x.status) },
          ].filter(Boolean),
          rows,
          { onRow: (x) => go(`requests/${x.id}`), empty: 'No requests here' },
        ),
      );
    };
    whSel.addEventListener('change', load);
    await load();
    return page(
      r === 'warehouse' ? 'Dispatch queue' : 'Stock requests',
      [r !== 'warehouse' ? h('button', { onclick: () => requestForm() }, 'New request') : null],
      h('div', { class: 'card' }, h('div', { class: 'filters' }, tabs, h('div', { style: 'margin-left:auto' }, whSel)), out),
    );
  };

  async function requestDetail(id) {
    const q = await get(`/requests/${id}`);
    const r = role();
    const canManage = isMgmt() || (r === 'account_manager' && q.account_manager_id === state.user.id);
    const reload = () => {
      invalidate('products');
      state.lastDashboard = null;
      render();
    };
    const collect = q.delivery_method === 'collect';
    const order = collect ? ['pending', 'approved', 'picking', 'delivered'] : ['pending', 'approved', 'picking', 'dispatched', 'delivered'];
    const idx = order.indexOf(q.status);
    const stepLabels = collect ? ['Requested', 'Approved', 'Picking', 'Collected'] : ['Requested', 'Approved', 'Picking', 'Dispatched', 'Delivered'];
    const steps = ['rejected', 'cancelled'].includes(q.status)
      ? h('div', { class: 'steps' }, h('span', { class: 'done' }, 'Requested'), h('span', { class: 'current' }, q.status === 'rejected' ? 'Rejected' : 'Cancelled'))
      : h('div', { class: 'steps' }, stepLabels.map((label, i) => h('span', { class: i < idx ? 'done' : i === idx ? 'current' : null }, label)));

    const approveInputs = new Map();
    const dispatchInputs = new Map();
    const scanned = new Map();
    const scanCells = new Map();
    const mode = canManage && q.status === 'pending' ? 'approve' : isOps() && ['approved', 'picking'].includes(q.status) ? 'dispatch' : null;
    const uniformsIn = q.items.some((i) => i.category === 'Uniform' && (i.qty_approved || i.qty_requested) > 0);
    const variant = (x) => (x.size ? h('div', { class: 'small' }, [GENDER_NAMES[x.gender], x.colour, x.size].filter(Boolean).join(' · ')) : null);
    const drawScan = (x) => {
      const cell = scanCells.get(x.id);
      if (!cell) return;
      const n = scanned.get(x.product_id) || 0;
      const target = Number((dispatchInputs.get(x.id) || {}).value || x.qty_approved);
      cell.replaceChildren(n >= target && target > 0 ? badge('received', `✓ ${n}`) : n ? badge('pending', `${n} / ${target}`) : h('span', { class: 'muted' }, '—'));
    };
    const items = table(
      [
        { label: 'Product', render: (x) => h('div', null, x.product_name, h('div', { class: 'small muted mono' }, x.sku), x.batches ? h('div', { class: 'small muted' }, `Batch: ${x.batches}`) : null) },
        isOps() ? { label: 'Bin', render: (x) => x.bin || '—' } : null,
        isOps() || canManage ? { label: `In ${q.warehouse_name}`, num: true, render: (x) => num(x.warehouse_qty) } : null,
        { label: 'Requested', num: true, render: (x) => num(x.qty_requested) },
        {
          label: 'Approved',
          num: true,
          render: (x) => {
            if (mode !== 'approve') return x.qty_approved === null ? '—' : num(x.qty_approved);
            const el = input({ type: 'number', min: '0', max: String(x.qty_requested), value: x.qty_requested, style: 'width:100px' });
            approveInputs.set(x.id, el);
            return el;
          },
        },
        {
          label: collect ? 'Issued' : 'Dispatched',
          num: true,
          render: (x) => {
            if (mode !== 'dispatch') return x.qty_dispatched === null ? '—' : num(x.qty_dispatched);
            const el = input({ type: 'number', min: '0', max: String(x.qty_approved), value: x.qty_approved, style: 'width:100px' });
            el.addEventListener('input', () => drawScan(x));
            dispatchInputs.set(x.id, el);
            return el;
          },
        },
        mode === 'dispatch'
          ? { label: 'Scanned', render: (x) => { const c = h('span'); scanCells.set(x.id, c); drawScan(x); return c; } }
          : null,
      ].filter(Boolean),
      q.items,
      { rowClass: (x) => (x.category === 'Uniform' ? 'uniform-row' : '') },
    );
    q.items.forEach(drawScan);

    const actions = h('div', { class: 'no-print', style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;align-items:end' });
    const extra = h('div', { class: 'no-print' });
    const note = input({ placeholder: 'Note to requester (optional)' });
    if (mode === 'approve') {
      const approve = h('button', { class: 'ok' }, 'Approve');
      approve.onclick = () =>
        busy(approve, async () => {
          await post(`/requests/${q.id}/approve`, { note: note.value, items: [...approveInputs].map(([itemId, el]) => ({ id: itemId, qty_approved: el.value })) });
          toast(`${q.ref} approved and sent to the warehouse`, 'ok');
          reload();
        });
      const reject = h('button', { class: 'danger' }, 'Reject');
      reject.onclick = () =>
        busy(reject, async () => {
          if (!note.value.trim()) throw new Error('Add a note explaining why the request is rejected');
          await post(`/requests/${q.id}/reject`, { note: note.value });
          toast(`${q.ref} rejected`);
          reload();
        });
      append(actions, h('div', { style: 'flex:1;min-width:220px' }, note), approve, reject);
    }
    if (mode === 'dispatch') {
      // Scan each item as it is picked; mismatches are flagged straight away
      const scanBtn = h('button', { class: 'secondary', type: 'button' }, '⌗ Scan items as you pick');
      scanBtn.onclick = () =>
        scanner(
          (code) => {
            const sku = skuFromCode(code);
            const item = q.items.find((i) => i.sku.toUpperCase() === sku || i.barcode === code);
            if (!item) throw new Error(`✗ ${sku} is not on this request`);
            scanned.set(item.product_id, (scanned.get(item.product_id) || 0) + 1);
            drawScan(item);
            return `✓ ${item.sku}: ${scanned.get(item.product_id)} of ${item.qty_approved} scanned`;
          },
          { title: `Pick ${q.ref}`, keepOpen: true, help: 'Scan each item’s QR label. Every scan counts one unit.' },
        );
      if (q.status === 'approved') {
        const pick = h('button', { class: 'secondary' }, 'Start picking');
        pick.onclick = () => busy(pick, async () => { await post(`/requests/${q.id}/pick`); reload(); });
        append(actions, pick);
      }
      append(actions, scanBtn, h('button', { class: 'secondary', onclick: () => window.print() }, 'Print picking slip'));

      const clean = input({ type: 'checkbox' });
      const ironed = input({ type: 'checkbox' });
      const courier = input({ placeholder: 'Courier (e.g. The Courier Guy)' });
      const waybill = input({ placeholder: q.delivery_method === 'courier' ? 'Waybill number (required)' : 'Waybill / reference' });
      const sig = collect ? signaturePad(`${q.promoter_name} signs to confirm they received this stock`) : null;
      const dispatchBtn = h('button', { class: 'ok big' }, collect ? `Issue to ${q.promoter_name}` : 'Dispatch');
      dispatchBtn.onclick = () =>
        busy(dispatchBtn, async () => {
          const signature = sig ? sig.value() : null;
          if (collect && !signature) throw new Error(`${q.promoter_name} needs to sign before the stock is handed over`);
          await post(`/requests/${q.id}/dispatch`, {
            courier: courier.value,
            waybill: waybill.value,
            items: [...dispatchInputs].map(([itemId, el]) => ({ id: itemId, qty_dispatched: el.value })),
            handover: { signature, uniform_clean: clean.checked, uniform_ironed: ironed.checked },
          });
          toast(collect ? `${q.ref} issued to ${q.promoter_name}` : `${q.ref} dispatched`, 'ok');
          reload();
        });
      append(
        extra,
        h(
          'div',
          { class: 'card handover-form' },
          h('h2', null, collect ? 'Hand over at the counter' : 'Send out'),
          h('div', { class: 'processing' }, `Processed by ${state.user.name} (${ROLE_NAMES[role()]}) → Promoter: ${q.promoter_name}${q.promoter_size ? ` · uniform ${GENDER_NAMES[q.promoter_gender] || ''} ${q.promoter_size}` : ''}`),
          uniformsIn
            ? h('div', { class: 'uniform-check' }, h('strong', null, 'Uniform check'), h('label', { class: 'check' }, clean, 'Uniforms are clean'), h('label', { class: 'check' }, ironed, 'Uniforms are ironed'))
            : null,
          collect ? null : h('div', { class: 'form-grid', style: 'margin-bottom:12px' }, q.delivery_method === 'courier' ? field('Courier', courier) : null, field('Waybill / reference', waybill)),
          sig ? sig.el : null,
          h('div', { style: 'margin-top:12px' }, dispatchBtn),
        ),
      );
    }
    if (q.status === 'dispatched' && ((r === 'promoter' && q.promoter_id === state.user.id) || isOps())) {
      const deliver = h('button', { class: 'ok' }, r === 'promoter' ? 'I have received this stock' : 'Mark as delivered');
      deliver.onclick = () => {
        if (r !== 'promoter') return busy(deliver, async () => { await post(`/requests/${q.id}/deliver`); toast('Delivery confirmed', 'ok'); reload(); });
        return confirmDelivery(q, reload);
      };
      append(actions, deliver);
    }
    if (['pending', 'approved', 'picking'].includes(q.status) && (q.requested_by === state.user.id || canManage)) {
      const cancel = h('button', { class: 'secondary' }, 'Cancel request');
      cancel.onclick = () =>
        busy(cancel, async () => {
          if (!confirm(`Cancel ${q.ref}?`)) return;
          await post(`/requests/${q.id}/cancel`);
          toast(`${q.ref} cancelled`);
          reload();
        });
      append(actions, cancel);
    }

    const showPhotos = q.delivery_method !== 'collect' || q.attachments.length;
    return page(
      h('span', null, h('span', { class: 'mono' }, q.ref), ' ', badge(q.status)),
      [h('a', { class: 'btn secondary', href: '#/requests' }, '← All requests')],
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'slip-head' }, steps, h('div', { class: 'print-only' }, qrImg(`JRR:${q.ref}`, 90))),
        h(
          'div',
          { class: 'grid two' },
          h(
            'dl',
            { class: 'dl' },
            h('dt', null, 'Campaign'), h('dd', null, h('a', { href: `#/campaigns/${q.campaign_id}` }, q.campaign_name), ` · ${q.client_name}`),
            h('dt', null, 'Promoter'), h('dd', null, q.promoter_name, q.promoter_phone ? ` · ${q.promoter_phone}` : '', q.promoter_size ? h('div', { class: 'small muted' }, `Uniform size ${GENDER_NAMES[q.promoter_gender] || ''} ${q.promoter_size}`) : null),
            h('dt', null, 'From'), h('dd', null, q.warehouse_name),
            h('dt', null, 'Needed by'), h('dd', null, fmtDate(q.needed_by)),
            h('dt', null, 'Delivery'), h('dd', null, DELIVERY[q.delivery_method] || q.delivery_method || '—'),
            q.delivery_address ? [h('dt', null, 'Address'), h('dd', null, q.delivery_address)] : null,
          ),
          h(
            'dl',
            { class: 'dl' },
            h('dt', null, 'Requested'), h('dd', null, `${q.requested_by_name}, ${fmtDateTime(q.created_at)}`),
            q.approved_by_name ? [h('dt', null, q.status === 'rejected' ? 'Rejected' : 'Approved'), h('dd', null, `${q.approved_by_name}, ${fmtDateTime(q.approved_at)}`)] : null,
            q.dispatched_by_name ? [h('dt', null, collect ? 'Issued by' : 'Dispatched'), h('dd', null, `${q.dispatched_by_name}, ${fmtDateTime(q.dispatched_at)}`)] : null,
            q.waybill ? [h('dt', null, 'Waybill'), h('dd', { class: 'mono' }, `${q.courier ? `${q.courier} · ` : ''}${q.waybill}`)] : null,
            q.delivered_at ? [h('dt', null, collect ? 'Collected' : 'Delivered'), h('dd', null, fmtDateTime(q.delivered_at))] : null,
            q.notes ? [h('dt', null, 'Notes'), h('dd', null, q.notes)] : null,
            q.decision_note ? [h('dt', null, 'Decision note'), h('dd', null, q.decision_note)] : null,
          ),
        ),
      ),
      h('div', { class: 'card' }, h('h2', null, 'Items'), items, actions),
      extra,
      q.handovers.length ? h('div', { class: 'card' }, h('h2', null, 'Handover record'), handoverCards(q.handovers)) : null,
      showPhotos
        ? h('div', { class: 'card no-print' }, attachmentsPanel({ kind: 'request', request_id: q.id }, q.attachments, {
            canUpload: isOps() || (r === 'promoter' && q.promoter_id === state.user.id),
            title: 'Waybill & delivery photos',
            emptyText: 'No photos. Add the courier waybill or a photo of the delivered boxes.',
          }))
        : null,
      h('div', { class: 'print-only sign-lines' }, h('div', null, 'Picked by: ________________'), h('div', null, 'Checked by: ________________'), h('div', null, 'Received by: ________________')),
    );
  }

  /** Promoter confirms a courier/vehicle delivery: sign, optionally snap the waybill. */
  function confirmDelivery(q, done) {
    const sig = signaturePad('Your signature');
    const files = [];
    const fileNote = h('div', { class: 'hint' });
    const picker = filePicker((chosen) => {
      files.push(...chosen);
      fileNote.textContent = `${files.length} photo(s) ready to upload`;
    }, { label: 'Photo of waybill' });
    const save = h('button', { class: 'ok' }, 'Confirm delivery');
    const m = modal(
      `Confirm ${q.ref}`,
      h('div', null, h('p', { class: 'muted', style: 'margin-top:0' }, 'Check the boxes and quantities, then sign. Add a photo of the waybill if you have one.'), sig.el, h('div', { style: 'margin-top:12px' }, picker, fileNote)),
      [save],
    );
    save.onclick = () =>
      busy(save, async () => {
        const signature = sig.value();
        if (!signature) throw new Error('Please sign to confirm');
        if (files.length) await uploadFiles({ kind: 'request', request_id: q.id }, files, 'Waybill on delivery');
        await post(`/requests/${q.id}/deliver`, { signature });
        m.close();
        toast('Delivery confirmed. Thank you!', 'ok');
        state.lastDashboard = null;
        done();
      });
  }

  async function myCampaignOptions() {
    const list = (await get('/campaigns')).filter((c) => ['planned', 'active'].includes(c.status));
    if (role() === 'account_manager') return list.filter((c) => c.account_manager_id === state.user.id);
    return list;
  }

  async function requestForm() {
    const [camps, whs] = await busy(null, () => Promise.all([myCampaignOptions(), warehouses()])) || [];
    if (!camps) return;
    if (!camps.length) return toast('There are no active campaigns you can request stock for', 'error');
    const isPromoter = role() === 'promoter';
    const campSel = select(camps.map((c) => ({ value: c.id, label: `${c.name} (${c.client_name})` })), {}, 'Choose campaign…');
    const promSel = select([], {}, 'Choose promoter…');
    const whSel = select(whs.filter((w) => w.active).map((w) => ({ value: w.id, label: `${w.name} (${w.city})` })), {}, 'Choose warehouse…');
    const needed = input({ type: 'date', min: today() });
    const method = select(Object.entries(DELIVERY).map(([value, label]) => ({ value, label })), { value: 'collect' });
    const address = input({ placeholder: 'Store / address for delivery' });
    const notes = h('textarea', { placeholder: 'Anything the warehouse or account manager should know' });
    const linesWrap = h('div', null, h('div', { class: 'muted small' }, 'Choose a campaign first'));
    const kitSel = select([], {}, '+ Add a kit…');
    const sizeHint = h('div', { class: 'hint' });
    let lines = null;
    let campProducts = [];
    let campPromoters = [];
    const kits = await get('/kits').catch(() => []);
    const showSize = () => {
      const who = isPromoter ? state.user : campPromoters.find((x) => String(x.id) === promSel.value);
      sizeHint.textContent = who && who.uniform_size ? `Uniform size on file: ${GENDER_NAMES[who.gender] || ''} ${who.uniform_size}` : '';
    };
    promSel.addEventListener('change', showSize);
    kitSel.addEventListener('change', () => {
      const kit = kits.find((k) => String(k.id) === kitSel.value);
      kitSel.value = '';
      if (!kit || !lines) return;
      const skipped = kit.items.filter((i) => !lines.add({ product_id: i.product_id, qty: i.qty }));
      toast(skipped.length ? `${kit.name} added, except ${skipped.map((i) => i.sku).join(', ')} (not for this client)` : `${kit.name} added`, skipped.length ? 'error' : 'ok');
    });
    const hintFor = (p) => {
      const a = p.availability.find((x) => String(x.warehouse_id) === whSel.value);
      return whSel.value ? `${num(a ? a.available : 0)} available in this warehouse` : p.availability.map((x) => `${x.warehouse_name}: ${num(x.available)}`).join(' · ');
    };
    campSel.addEventListener('change', async () => {
      if (!campSel.value) return;
      const [prods, detail] = await Promise.all([get(`/campaigns/${campSel.value}/products`), isPromoter ? null : get(`/campaigns/${campSel.value}`)]);
      campProducts = prods;
      if (detail) {
        campPromoters = detail.promoters;
        promSel.replaceChildren(h('option', { value: '' }, detail.promoters.length ? 'Choose promoter…' : 'No promoters on this campaign'));
        for (const p of detail.promoters) promSel.append(h('option', { value: p.id }, `${p.name}${p.region ? ` (${p.region})` : ''}`));
      }
      showSize();
      const ids = new Set(prods.map((p) => p.id));
      kitSel.replaceChildren(h('option', { value: '' }, '+ Add a kit…'), ...kits.filter((k) => k.items.some((i) => ids.has(i.product_id))).map((k) => h('option', { value: k.id }, k.name)));
      lines = linesEditor(prods.map((p) => ({ id: p.id, label: `${p.sku} · ${p.name}`, group: p.is_house ? `JR stock · ${p.category}` : p.category, hint: hintFor(p) })));
      linesWrap.replaceChildren(lines.el);
    });
    whSel.addEventListener('change', () => lines && lines.el.refreshHints((p) => hintFor(campProducts.find((c) => c.id === p.id) || p)));
    const save = h('button', null, 'Submit request');
    const m = modal(
      'New stock request',
      h(
        'div',
        null,
        h(
          'div',
          { class: 'form-grid' },
          field('Campaign', campSel, { full: true }),
          isPromoter ? null : field('For promoter', promSel),
          field('Send from', whSel),
          field('Needed by', needed),
          field('Delivery', method),
          field('Delivery address', address, { full: true }),
        ),
        h('div', { class: 'page-head', style: 'margin:16px 0 8px' }, h('h3', { style: 'margin:0' }, 'Products'), h('div', { style: 'max-width:260px' }, kitSel)),
        sizeHint,
        linesWrap,
        h('div', { style: 'margin-top:12px' }, field('Notes', notes)),
        isPromoter ? null : h('p', { class: 'hint' }, 'Requests you raise for your own campaigns are approved immediately.'),
      ),
      [save],
    );
    save.onclick = () =>
      busy(save, async () => {
        if (!lines) throw new Error('Choose a campaign first');
        const res = await post('/requests', {
          campaign_id: campSel.value,
          promoter_id: isPromoter ? undefined : promSel.value,
          warehouse_id: whSel.value,
          needed_by: needed.value,
          delivery_method: method.value,
          delivery_address: address.value,
          notes: notes.value,
          items: lines.values().map((l) => ({ product_id: l.product_id, qty: l.qty })),
        });
        m.close();
        toast(`${res.ref} submitted${res.status === 'approved' ? ' and approved' : ''}`, 'ok');
        state.lastDashboard = null;
        go(`requests/${res.id}`);
      });
  }

  // ------------------------------------------------------------------ returns

  routes.returns = async () => {
    let status = role() === 'promoter' ? '' : 'pending';
    const tabs = h('div', { class: 'tabs' });
    const out = h('div');
    const load = async () => {
      tabs.replaceChildren(
        ...[['pending', 'To check in'], ['received', 'Received'], ['', 'All']].map(([s, label]) =>
          h('button', { class: s === status ? 'active' : null, onclick: () => { status = s; load(); } }, label),
        ),
      );
      const rows = await get(`/returns${qs({ status })}`);
      out.replaceChildren(
        table(
          [
            { label: 'Ref', render: (x) => h('span', { class: 'mono' }, x.ref) },
            { label: 'Campaign', render: (x) => h('div', null, x.campaign_name, h('div', { class: 'small muted' }, x.client_name)) },
            role() === 'promoter' ? null : { label: 'Promoter', key: 'promoter_name' },
            { label: 'To', key: 'warehouse_name' },
            { label: 'Logged', render: (x) => fmtDate(x.created_at) },
            { label: 'Units', num: true, render: (x) => num(x.units) },
            { label: 'Status', render: (x) => badge(x.status) },
          ].filter(Boolean),
          rows,
          { onRow: (x) => returnDetail(x.id, load), empty: 'No returns here' },
        ),
      );
    };
    await load();
    return page(
      'Returns',
      [role() !== 'warehouse' ? h('button', { onclick: () => returnForm(load) }, 'Log a return') : null],
      h('div', { class: 'card' }, h('p', { class: 'muted small', style: 'margin-top:0' }, 'Unused stock coming back from promoters. The warehouse checks it in, splitting good and damaged units.'), tabs, out),
    );
  };

  async function returnDetail(id, done) {
    const rt = await busy(null, () => get(`/returns/${id}`));
    if (!rt) return;
    const receiving = isOps() && rt.status === 'pending';
    const inputs = new Map();
    const anyUniform = rt.items.some((x) => x.category === 'Uniform');
    const numIn = (v) => input({ type: 'number', min: '0', value: v, style: 'width:80px', inputmode: 'numeric' });
    const sig = receiving ? signaturePad('Promoter signature (if they are here)') : null;
    const body = h(
      'div',
      null,
      receiving ? h('div', { class: 'processing' }, `Checking in as ${state.user.name} · Promoter: ${rt.promoter_name}`) : null,
      h(
        'dl',
        { class: 'dl', style: 'margin-bottom:14px' },
        h('dt', null, 'Status'), h('dd', null, badge(rt.status)),
        h('dt', null, 'Campaign'), h('dd', null, `${rt.campaign_name} · ${rt.client_name}`),
        h('dt', null, 'Promoter'), h('dd', null, rt.promoter_name),
        h('dt', null, 'Warehouse'), h('dd', null, rt.warehouse_name),
        rt.received_by_name ? [h('dt', null, 'Checked in'), h('dd', null, `${rt.received_by_name}, ${fmtDateTime(rt.received_at)}`)] : null,
        rt.notes ? [h('dt', null, 'Notes'), h('dd', null, rt.notes)] : null,
      ),
      table(
        [
          { label: 'Product', render: (x) => h('div', null, x.product_name, h('div', { class: 'small muted mono' }, x.sku)) },
          { label: 'Declared', num: true, render: (x) => num(x.qty) },
          {
            label: anyUniform ? 'Good (clean & ironed)' : 'Good',
            num: true,
            render: (x) => {
              if (!receiving) return x.qty_good === null ? '—' : num(x.qty_good);
              const i = { good: numIn(x.qty), laundry: numIn(0), bad: numIn(0) };
              inputs.set(x.id, i);
              return i.good;
            },
          },
          anyUniform
            ? { label: 'Needs wash / iron', num: true, render: (x) => (x.category !== 'Uniform' ? '—' : receiving ? inputs.get(x.id).laundry : x.qty_laundry === null ? '—' : num(x.qty_laundry)) }
            : null,
          { label: 'Damaged', num: true, render: (x) => (receiving ? inputs.get(x.id).bad : x.qty_damaged === null ? '—' : num(x.qty_damaged)) },
        ].filter(Boolean),
        rt.items,
      ),
      receiving ? h('p', { class: 'hint' }, 'Good units go back into stock. Uniforms that aren’t clean and ironed go to the laundry. Damaged units are written off. Anything not counted stays against the promoter.') : null,
      sig ? sig.el : null,
      handoverCards(rt.handovers),
      h('div', { style: 'margin-top:14px' }, attachmentsPanel({ kind: 'return', return_id: rt.id }, rt.attachments, { canUpload: isOps() || role() === 'promoter', title: 'Photos', emptyText: 'No photos' })),
    );
    const buttons = [];
    if (receiving) {
      const recv = h('button', { class: 'ok' }, 'Check in return');
      recv.onclick = () =>
        busy(recv, async () => {
          await post(`/returns/${rt.id}/receive`, {
            items: [...inputs].map(([itemId, i]) => ({ id: itemId, qty_good: i.good.value, qty_laundry: i.laundry.value, qty_damaged: i.bad.value })),
            handover: { signature: sig.value() },
          });
          m.close();
          toast(`${rt.ref} checked in`, 'ok');
          invalidate('products');
          state.lastDashboard = null;
          if (done) done();
          else render();
        });
      buttons.push(recv);
    }
    if (rt.status === 'pending' && role() !== 'warehouse') {
      const cancel = h('button', { class: 'secondary' }, 'Cancel return');
      cancel.onclick = () => busy(cancel, async () => { await post(`/returns/${rt.id}/cancel`); m.close(); if (done) done(); });
      buttons.push(cancel);
    }
    const m = modal(`Return ${rt.ref}`, body, buttons, { wide: true });
  }

  /** Stock a promoter holds, as [{campaign_id, product_id, qty, ...}], for promoter or chosen promoter. */
  async function holdingsFor(promoterId) {
    if (role() === 'promoter') return get('/stock/mine');
    const all = await get('/stock/field');
    return all.filter((f) => String(f.promoter_id) === String(promoterId));
  }

  /** Shared picker: (promoter →) campaign → products currently held. */
  async function holdingPicker({ onChange }) {
    const isPromoter = role() === 'promoter';
    let promoters = [];
    if (!isPromoter) {
      const field = await get('/stock/field');
      const seen = new Map();
      for (const f of field) seen.set(f.promoter_id, f.promoter_name);
      promoters = [...seen].map(([value, label]) => ({ value, label }));
    }
    const promSel = select(promoters, {}, promoters.length ? 'Choose promoter…' : 'No promoters hold stock');
    const campSel = select([], {}, 'Choose campaign…');
    let holdings = [];
    const loadHoldings = async () => {
      holdings = await holdingsFor(promSel.value);
      const camps = new Map();
      for (const x of holdings) camps.set(x.campaign_id, x.campaign_name);
      campSel.replaceChildren(h('option', { value: '' }, camps.size ? 'Choose campaign…' : 'No stock held'));
      for (const [value, label] of camps) campSel.append(h('option', { value }, label));
      onChange([]);
    };
    promSel.addEventListener('change', loadHoldings);
    campSel.addEventListener('change', () => onChange(holdings.filter((x) => String(x.campaign_id) === campSel.value)));
    if (isPromoter) await loadHoldings();
    return {
      fields: [isPromoter ? null : field('Promoter', promSel), field('Campaign', campSel)],
      promoterId: () => (isPromoter ? undefined : promSel.value),
      campaignId: () => campSel.value,
    };
  }

  async function returnForm(done) {
    const whs = await warehouses();
    const linesWrap = h('div', null, h('div', { class: 'muted small' }, 'Choose a campaign to see the stock you hold'));
    const qtyInputs = new Map();
    const picker = await holdingPicker({
      onChange: (rows) => {
        qtyInputs.clear();
        linesWrap.replaceChildren(
          rows.length
            ? table(
                [
                  { label: 'Product', render: (x) => h('div', null, x.product_name, h('div', { class: 'small muted mono' }, x.sku)) },
                  { label: 'Holding', num: true, render: (x) => num(x.qty) },
                  {
                    label: 'Returning',
                    num: true,
                    render: (x) => {
                      const el = input({ type: 'number', min: '0', max: String(x.qty), value: x.qty, style: 'width:100px' });
                      qtyInputs.set(x.product_id, el);
                      return el;
                    },
                  },
                ],
                rows,
              )
            : h('div', { class: 'muted small' }, 'Choose a campaign to see the stock held'),
        );
      },
    });
    const whSel = select(whs.filter((w) => w.active).map((w) => ({ value: w.id, label: `${w.name} (${w.city})` })), {}, 'Return to…');
    const notes = h('textarea', { placeholder: 'How is it coming back? (courier, drop-off, etc.)' });
    const save = h('button', null, 'Log return');
    const m = modal('Return stock to warehouse', h('div', null, h('div', { class: 'form-grid' }, picker.fields, field('Warehouse', whSel)), h('div', { style: 'margin-top:14px' }, linesWrap), h('div', { style: 'margin-top:12px' }, field('Notes', notes))), [save]);
    save.onclick = () =>
      busy(save, async () => {
        const items = [...qtyInputs].map(([product_id, el]) => ({ product_id, qty: Number(el.value) })).filter((i) => i.qty > 0);
        const res = await post('/returns', { campaign_id: picker.campaignId(), promoter_id: picker.promoterId(), warehouse_id: whSel.value, notes: notes.value, items });
        m.close();
        toast(`${res.ref} logged. The warehouse will check it in.`, 'ok');
        if (done) done();
        else go('returns');
      });
  }

  // ------------------------------------------------------------------ activation (usage) reports

  routes.usage = async () => {
    const rows = await get('/usage');
    return page(
      'Activation reports',
      [role() === 'warehouse' ? null : h('button', { onclick: () => usageForm() }, 'Log activation')],
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'muted small', style: 'margin-top:0' }, 'What promoters handed out or used at each activation. Reports reduce the stock a promoter holds.'),
        table(
          [
            { label: 'Date', render: (x) => fmtDate(x.report_date), class: 'nowrap' },
            { label: 'Campaign', render: (x) => h('div', null, x.campaign_name, h('div', { class: 'small muted' }, x.client_name)) },
            role() === 'promoter' ? null : { label: 'Promoter', key: 'promoter_name' },
            { label: 'Store / venue', render: (x) => x.store || '—' },
            { label: 'Items', render: (x) => h('div', { class: 'small' }, x.items.map((i) => h('div', null, `${num(i.qty_used)} × ${i.product_name}`, i.qty_damaged ? h('span', { class: 'muted' }, ` (+${i.qty_damaged} damaged)`) : null))) },
            { label: 'Units', num: true, render: (x) => num(x.units_used) },
          ].filter(Boolean),
          rows,
          { empty: 'No activation reports yet' },
        ),
      ),
    );
  };

  async function usageForm() {
    const inputs = new Map();
    const linesWrap = h('div', null, h('div', { class: 'muted small' }, 'Choose a campaign to see the stock held'));
    const picker = await busy(null, () =>
      holdingPicker({
        onChange: (rows) => {
          inputs.clear();
          linesWrap.replaceChildren(
            rows.length
              ? table(
                  [
                    { label: 'Product', render: (x) => h('div', null, x.product_name, h('div', { class: 'small muted mono' }, x.sku)) },
                    { label: 'Holding', num: true, render: (x) => num(x.qty) },
                    {
                      label: 'Used / handed out',
                      num: true,
                      render: (x) => {
                        const used = input({ type: 'number', min: '0', max: String(x.qty), placeholder: '0', style: 'width:100px', inputmode: 'numeric' });
                        const dmg = input({ type: 'number', min: '0', max: String(x.qty), placeholder: '0', style: 'width:80px', inputmode: 'numeric' });
                        inputs.set(x.product_id, { used, dmg });
                        return used;
                      },
                    },
                    { label: 'Damaged', num: true, render: (x) => inputs.get(x.product_id).dmg },
                  ],
                  rows,
                )
              : h('div', { class: 'muted small' }, 'Choose a campaign to see the stock held'),
          );
        },
      }),
    );
    if (!picker) return;
    const date = input({ type: 'date', value: today(), max: today() });
    const store = input({ placeholder: 'e.g. Pick n Pay Rosebank' });
    const notes = h('textarea', { placeholder: 'Foot traffic, feedback, stock issues…' });
    const save = h('button', null, 'Submit report');
    const m = modal(
      'Log activation',
      h('div', null, h('div', { class: 'form-grid' }, picker.fields, field('Date', date), field('Store / venue', store)), h('div', { style: 'margin-top:14px' }, linesWrap), h('div', { style: 'margin-top:12px' }, field('Notes', notes))),
      [save],
    );
    save.onclick = () =>
      busy(save, async () => {
        const items = [...inputs]
          .map(([product_id, i]) => ({ product_id, qty_used: Number(i.used.value || 0), qty_damaged: Number(i.dmg.value || 0) }))
          .filter((i) => i.qty_used || i.qty_damaged);
        await post('/usage', { campaign_id: picker.campaignId(), promoter_id: picker.promoterId(), report_date: date.value, store: store.value, notes: notes.value, items });
        m.close();
        toast('Activation report saved', 'ok');
        state.lastDashboard = null;
        render();
      });
  }

  // ------------------------------------------------------------------ campaigns

  routes.campaigns = async (id) => {
    if (id) return campaignDetail(id);
    const rows = await get('/campaigns');
    const canCreate = isMgmt() || role() === 'account_manager';
    return page(
      role() === 'promoter' ? 'My campaigns' : 'Campaigns',
      [canCreate ? h('button', { onclick: () => campaignForm() }, 'New campaign') : null],
      h(
        'div',
        { class: 'card' },
        table(
          [
            { label: 'Campaign', render: (x) => h('div', null, h('strong', null, x.name), h('div', { class: 'small muted' }, x.client_name)) },
            { label: 'Region', render: (x) => x.region || '—' },
            { label: 'Dates', render: (x) => `${fmtDate(x.start_date)} – ${fmtDate(x.end_date)}`, class: 'nowrap' },
            role() === 'promoter' ? null : { label: 'Account manager', render: (x) => x.account_manager_name || '—' },
            role() === 'promoter' ? null : { label: 'Promoters', num: true, render: (x) => num(x.promoter_count) },
            { label: 'Units in field', num: true, render: (x) => num(x.in_field) },
            { label: 'Status', render: (x) => badge(x.status) },
          ].filter(Boolean),
          rows,
          { onRow: (x) => go(`campaigns/${x.id}`), empty: 'No campaigns yet' },
        ),
      ),
    );
  };

  async function campaignDetail(id) {
    const [c, reqs] = await Promise.all([get(`/campaigns/${id}`), get(`/requests${qs({ campaign_id: id })}`)]);
    const canManage = isMgmt() || (role() === 'account_manager' && c.account_manager_id === state.user.id);
    const cost = canSeeCost();
    const totals = c.summary.reduce(
      (t, x) => ({ dispatched: t.dispatched + x.dispatched, used: t.used + x.used, damaged: t.damaged + x.damaged, returned: t.returned + x.returned, in_field: t.in_field + x.in_field, cost: t.cost + (x.cost_used || 0) }),
      { dispatched: 0, used: 0, damaged: 0, returned: 0, in_field: 0, cost: 0 },
    );
    return page(
      h('span', null, c.name, ' ', badge(c.status)),
      [
        h('a', { class: 'btn secondary', href: '#/campaigns' }, '← Campaigns'),
        role() !== 'warehouse' && ['planned', 'active'].includes(c.status) ? h('button', { onclick: () => requestForm() }, 'Request stock') : null,
        canManage ? h('button', { class: 'secondary', onclick: () => campaignForm(c) }, 'Edit') : null,
      ],
      h(
        'div',
        { class: 'kpis' },
        kpi('Dispatched', num(totals.dispatched)),
        kpi('Used / handed out', num(totals.used)),
        kpi('Damaged', num(totals.damaged), { alert: totals.damaged > 0 }),
        kpi('Returned', num(totals.returned)),
        kpi('Still with promoters', num(totals.in_field)),
        cost ? kpi('Cost of stock used', money(totals.cost)) : null,
      ),
      h(
        'div',
        { class: 'grid two' },
        h(
          'div',
          { class: 'card' },
          h('h2', null, 'Details'),
          h(
            'dl',
            { class: 'dl' },
            h('dt', null, 'Client'), h('dd', null, c.client_name),
            h('dt', null, 'Account manager'), h('dd', null, c.account_manager_name || '—'),
            h('dt', null, 'Region'), h('dd', null, c.region || '—'),
            h('dt', null, 'Dates'), h('dd', null, `${fmtDate(c.start_date)} – ${fmtDate(c.end_date)}`),
            c.notes ? [h('dt', null, 'Notes'), h('dd', null, c.notes)] : null,
          ),
        ),
        h(
          'div',
          { class: 'card' },
          h('h2', null, 'Promoters'),
          c.promoters.length
            ? h('div', { class: 'list' }, c.promoters.map((p) => h('div', { class: 'list-item' }, h('div', null, h('strong', null, p.name), h('div', { class: 'small muted' }, [p.region, p.phone].filter(Boolean).join(' · '))))))
            : h('div', { class: 'empty' }, 'No promoters assigned'),
        ),
      ),
      role() === 'promoter' ? null : h('div', { style: 'margin-top:16px' }, planCard(c, canManage)),
      h(
        'div',
        { class: 'card', style: 'margin-top:16px' },
        h('h2', null, 'Stock reconciliation'),
        h('p', { class: 'muted small', style: 'margin-top:0' }, 'Dispatched = used + damaged + returned + still with promoters.'),
        table(
          [
            { label: 'Product', render: (x) => h('div', null, x.product_name, h('div', { class: 'small muted mono' }, x.sku)) },
            { label: 'Dispatched', num: true, render: (x) => num(x.dispatched) },
            { label: 'Used', num: true, render: (x) => num(x.used) },
            { label: 'Damaged', num: true, render: (x) => num(x.damaged) },
            { label: 'Returned', num: true, render: (x) => num(x.returned) },
            { label: 'With promoters', num: true, render: (x) => num(x.in_field) },
            cost ? { label: 'Cost used', num: true, render: (x) => money(x.cost_used) } : null,
          ].filter(Boolean),
          c.summary,
          { empty: 'No stock has moved on this campaign yet' },
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', null, 'Stock requests'),
        table(
          [
            { label: 'Ref', render: (x) => h('span', { class: 'mono' }, x.ref) },
            { label: 'Promoter', key: 'promoter_name' },
            { label: 'Warehouse', key: 'warehouse_name' },
            { label: 'Created', render: (x) => fmtDate(x.created_at) },
            { label: 'Units', num: true, render: (x) => num(x.units) },
            { label: 'Status', render: (x) => badge(x.status) },
          ],
          reqs,
          { onRow: (x) => go(`requests/${x.id}`), empty: 'No requests yet' },
        ),
      ),
    );
  }

  async function campaignForm(c) {
    const [cls, users] = await busy(null, () => Promise.all([clients(), get('/users')])) || [];
    if (!cls) return;
    const mine = role() === 'account_manager' ? cls.filter((x) => x.account_manager_id === state.user.id) : cls;
    const ams = users.filter((u) => u.role === 'account_manager' && u.active);
    const promoters = users.filter((u) => u.role === 'promoter' && u.active);
    const assigned = new Set((c ? c.promoters : []).map((p) => p.id));
    const f = {
      name: input({ value: c ? c.name : '' }),
      client_id: select(mine.map((x) => ({ value: x.id, label: x.name })), { value: c ? c.client_id : '' }, 'Choose client…'),
      account_manager_id: select(ams.map((u) => ({ value: u.id, label: u.name })), { value: c ? c.account_manager_id || '' : '' }, "Client's account manager"),
      region: select(
        ['Gauteng', 'Western Cape', 'KwaZulu-Natal', 'Eastern Cape', 'Free State', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape', 'National'].map((p) => ({ value: p, label: p })),
        { value: c ? c.region || '' : '' },
        'Choose region…',
      ),
      start_date: input({ type: 'date', value: c ? c.start_date || '' : '' }),
      end_date: input({ type: 'date', value: c ? c.end_date || '' : '' }),
      status: select(['planned', 'active', 'completed', 'cancelled'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })), { value: c ? c.status : 'planned' }),
      notes: h('textarea', null, c ? c.notes || '' : ''),
    };
    const boxes = promoters.map((p) => {
      const box = input({ type: 'checkbox', value: p.id, checked: assigned.has(p.id) });
      return h('label', { class: 'check', style: 'margin:4px 14px 4px 0' }, box, `${p.name}${p.region ? ` (${p.region})` : ''}`);
    });
    const save = h('button', null, c ? 'Save campaign' : 'Create campaign');
    const m = modal(
      c ? `Edit ${c.name}` : 'New campaign',
      h(
        'div',
        { class: 'form-grid' },
        field('Campaign name', f.name, { full: true }),
        field('Client', f.client_id),
        isMgmt() ? field('Account manager', f.account_manager_id) : null,
        field('Region', f.region),
        field('Status', f.status),
        field('Start date', f.start_date),
        field('End date', f.end_date),
        field('Promoters', h('div', { style: 'display:flex;flex-wrap:wrap' }, boxes.length ? boxes : h('span', { class: 'muted' }, 'No promoters set up yet')), { full: true }),
        field('Notes', f.notes, { full: true }),
      ),
      [save],
    );
    save.onclick = () =>
      busy(save, async () => {
        const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
        body.promoter_ids = boxes.map((b) => b.querySelector('input')).filter((b) => b.checked).map((b) => Number(b.value));
        const saved = c ? await put(`/campaigns/${c.id}`, body) : await post('/campaigns', body);
        invalidate('campaigns');
        m.close();
        toast(c ? 'Campaign saved' : 'Campaign created', 'ok');
        go(`campaigns/${saved.id}`);
      });
  }

  // ------------------------------------------------------------------ setup: clients, warehouses, users

  routes.clients = async () => {
    invalidate('clients');
    const rows = await clients();
    const cols = [
      { label: 'Client', render: (x) => h('div', null, h('strong', null, x.name), x.is_house ? [' ', badge('approved', 'JR stock')] : null, x.active ? null : [' ', badge('cancelled', 'inactive')]) },
      { label: 'Contact', render: (x) => h('div', { class: 'small' }, x.contact_name || '—', x.contact_email ? h('div', { class: 'muted' }, x.contact_email) : null, x.contact_phone ? h('div', { class: 'muted' }, x.contact_phone) : null) },
      { label: 'Account manager', render: (x) => x.account_manager_name || '—' },
      { label: 'Products', num: true, render: (x) => num(x.product_count) },
      { label: 'Active campaigns', num: true, render: (x) => num(x.active_campaigns) },
    ];
    if (canSeeCost()) cols.push({ label: 'Stock value', num: true, render: (x) => money(x.stock_value) });
    return page(
      'Clients',
      [isMgmt() ? h('button', { onclick: () => clientForm() }, 'New client') : null],
      h('div', { class: 'card' }, table(cols, rows, { onRow: isMgmt() ? (x) => clientForm(x) : null, empty: 'No clients yet' })),
    );
  };

  async function clientForm(c) {
    const users = await get('/users');
    const f = {
      name: input({ value: c ? c.name : '' }),
      contact_name: input({ value: c ? c.contact_name || '' : '' }),
      contact_email: input({ type: 'email', value: c ? c.contact_email || '' : '' }),
      contact_phone: input({ type: 'tel', value: c ? c.contact_phone || '' : '' }),
      account_manager_id: select(users.filter((u) => u.role === 'account_manager' && u.active).map((u) => ({ value: u.id, label: u.name })), { value: c ? c.account_manager_id || '' : '' }, 'Unassigned'),
      active: input({ type: 'checkbox', checked: c ? !!c.active : true }),
      is_house: input({ type: 'checkbox', checked: c ? !!c.is_house : false }),
    };
    const save = h('button', null, c ? 'Save client' : 'Create client');
    const m = modal(
      c ? c.name : 'New client',
      h('div', { class: 'form-grid' }, field('Client / brand name', f.name, { full: true }), field('Contact person', f.contact_name), field('Contact email', f.contact_email), field('Contact phone', f.contact_phone), field('Account manager', f.account_manager_id), h('label', { class: 'check field full' }, f.is_house, 'Company-owned stock (JR’s own tables, setups and uniforms, usable on any campaign)'), h('label', { class: 'check field full' }, f.active, 'Active')),
      [save],
    );
    save.onclick = () =>
      busy(save, async () => {
        const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
        if (c) await put(`/clients/${c.id}`, body);
        else await post('/clients', body);
        invalidate('clients');
        m.close();
        toast('Client saved', 'ok');
        render();
      });
  }

  routes.warehouses = async () => {
    invalidate('warehouses');
    const rows = await warehouses();
    return page(
      'Warehouses',
      [isMgmt() ? h('button', { onclick: () => warehouseForm() }, 'New warehouse') : null],
      h(
        'div',
        { class: 'card' },
        table(
          [
            { label: 'Warehouse', render: (x) => h('div', null, h('strong', null, x.name), x.active ? null : [' ', badge('cancelled', 'inactive')]) },
            { label: 'Location', render: (x) => `${x.city}, ${x.province}` },
            { label: 'Address', render: (x) => x.address || '—' },
            { label: 'Units', num: true, render: (x) => num(x.units) },
            { label: 'Value', num: true, render: (x) => money(x.value) },
          ],
          rows,
          { onRow: (x) => warehouseForm(x) },
        ),
      ),
    );
  };

  function warehouseForm(w) {
    const f = {
      name: input({ value: w ? w.name : '' }),
      city: input({ value: w ? w.city : '' }),
      province: select(
        ['Gauteng', 'Western Cape', 'KwaZulu-Natal', 'Eastern Cape', 'Free State', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape'].map((p) => ({ value: p, label: p })),
        { value: w ? w.province : '' },
        'Choose province…',
      ),
      address: input({ value: w ? w.address || '' : '' }),
      active: input({ type: 'checkbox', checked: w ? !!w.active : true }),
    };
    const save = h('button', null, 'Save warehouse');
    const m = modal(w ? w.name : 'New warehouse', h('div', { class: 'form-grid' }, field('Name', f.name), field('City / area', f.city), field('Province', f.province), field('Address', f.address, { full: true }), h('label', { class: 'check field full' }, f.active, 'Active')), [save]);
    save.onclick = () =>
      busy(save, async () => {
        const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
        if (w) await put(`/warehouses/${w.id}`, body);
        else await post('/warehouses', body);
        invalidate('warehouses');
        m.close();
        toast('Warehouse saved', 'ok');
        render();
      });
  }

  routes.users = async () => {
    const [rows, whs] = await Promise.all([get('/users'), warehouses()]);
    const counts = rows.filter((u) => u.active).reduce((m, u) => ({ ...m, [u.role]: (m[u.role] || 0) + 1 }), {});
    return page(
      'Staff & users',
      [h('button', { onclick: () => userForm(null, whs) }, 'Add user')],
      h('div', { class: 'kpis' }, Object.entries(ROLE_NAMES).map(([k, label]) => kpi(label, num(counts[k] || 0)))),
      h(
        'div',
        { class: 'card' },
        table(
          [
            { label: 'Name', render: (x) => h('div', null, h('strong', null, x.name), x.active ? null : [' ', badge('cancelled', 'inactive')]) },
            { label: 'Role', render: (x) => ROLE_NAMES[x.role] },
            { label: 'Email', key: 'email' },
            { label: 'Phone', render: (x) => x.phone || '—' },
            { label: 'Region', render: (x) => x.region || '—' },
            { label: 'Uniform', render: (x) => (x.uniform_size ? `${GENDER_NAMES[x.gender] || ''} ${x.uniform_size}` : '—') },
            { label: 'Warehouse', render: (x) => x.warehouse_name || '—' },
          ],
          rows,
          { onRow: (x) => userForm(x, whs) },
        ),
      ),
    );
  };

  function userForm(u, whs) {
    const f = {
      name: input({ value: u ? u.name : '' }),
      email: input({ type: 'email', value: u ? u.email : '' }),
      phone: input({ type: 'tel', value: u ? u.phone || '' : '' }),
      role: select(Object.entries(ROLE_NAMES).map(([value, label]) => ({ value, label })), { value: u ? u.role : 'promoter' }),
      region: select(
        ['Gauteng', 'Western Cape', 'KwaZulu-Natal', 'Eastern Cape', 'Free State', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape'].map((p) => ({ value: p, label: p })),
        { value: u ? u.region || '' : '' },
        '—',
      ),
      warehouse_id: select(whs.map((w) => ({ value: w.id, label: w.name })), { value: u ? u.warehouse_id || '' : '' }, 'None'),
      gender: select([{ value: 'female', label: 'Ladies' }, { value: 'male', label: 'Mens' }], { value: u ? u.gender || '' : '' }, '—'),
      uniform_size: select(['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'].map((x) => ({ value: x, label: x })), { value: u ? u.uniform_size || '' : '' }, '—'),
      password: input({ type: 'password', autocomplete: 'new-password', placeholder: u ? 'Leave blank to keep current' : 'At least 8 characters' }),
      active: input({ type: 'checkbox', checked: u ? !!u.active : true }),
    };
    const save = h('button', null, u ? 'Save user' : 'Create user');
    const reissue = u && u.role === 'promoter'
      ? h('button', { class: 'secondary', onclick: (e) => busy(e.target, async () => {
          if (!confirm(`Issue ${u.name} a new ID badge? The old QR code will stop working.`)) return;
          await post(`/users/${u.id}/badge`);
          toast('New badge issued. Print it under Promoter badges.', 'ok');
        }) }, 'Reissue ID badge')
      : null;
    const m = modal(
      u ? u.name : 'Add user',
      h(
        'div',
        { class: 'form-grid' },
        field('Full name', f.name),
        field('Email (sign-in)', f.email),
        field('Cell number', f.phone),
        field('Role', f.role),
        field('Region', f.region),
        field('Home warehouse', f.warehouse_id, { hint: 'For warehouse staff: filters their dispatch queue' }),
        field('Uniform cut', f.gender),
        field('Uniform size', f.uniform_size),
        field(u ? 'Reset password' : 'Password', f.password),
        h('label', { class: 'check field full' }, f.active, 'Active (can sign in)'),
      ),
      [reissue, save].filter(Boolean),
    );
    save.onclick = () =>
      busy(save, async () => {
        const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
        if (!body.password) delete body.password;
        if (u) await patch(`/users/${u.id}`, body);
        else await post('/users', body);
        m.close();
        toast('User saved', 'ok');
        render();
      });
  }

  // ------------------------------------------------------------------ reminders

  const REMINDER_GROUPS = { out: 'Needs to go out', missing: 'Missing or not confirmed', stock: 'Stock health' };

  function reminderList(list, { limit } = {}) {
    const shown = limit ? list.slice(0, limit) : list;
    if (!shown.length) return h('div', { class: 'empty' }, 'Nothing needs attention right now 🎉');
    return h(
      'div',
      { class: 'list' },
      shown.map((r) =>
        h(
          'a',
          { class: `reminder ${r.severity}`, href: `#/${r.link}` },
          h('span', { class: 'dot', 'aria-hidden': 'true' }),
          h('div', null, h('strong', null, r.title), h('div', { class: 'small muted' }, r.detail)),
        ),
      ),
    );
  }

  routes.reminders = async () => {
    const list = await get('/reminders');
    const groups = Object.entries(REMINDER_GROUPS)
      .map(([key, label]) => [label, list.filter((r) => r.group === key)])
      .filter(([, rows]) => rows.length);
    return page(
      'Reminders',
      null,
      h('p', { class: 'muted', style: 'margin-top:-8px' }, 'Worked out live from the system. Each one clears as soon as it is dealt with.'),
      groups.length
        ? groups.map(([label, rows]) => h('div', { class: 'card' }, h('h2', null, `${label} (${rows.length})`), reminderList(rows)))
        : h('div', { class: 'card' }, reminderList([])),
    );
  };

  // ------------------------------------------------------------------ handovers

  function uniformCheck(hd) {
    if (hd.uniform_clean === null || hd.uniform_clean === undefined) return '—';
    return hd.uniform_clean && hd.uniform_ironed ? badge('received', '✓ Clean & ironed') : badge('rejected', 'Needs laundry');
  }

  /** "Processed by X → Promoter Y" cards with signatures, used on requests, returns and the counter. */
  function handoverCards(list) {
    if (!list || !list.length) return null;
    return h(
      'div',
      { class: 'handovers' },
      list.map((hd) =>
        h(
          'div',
          { class: 'handover' },
          h(
            'div',
            { class: 'handover-who' },
            h('div', null, h('div', { class: 'label' }, hd.kind === 'return' ? 'Checked in by' : hd.staff_id ? 'Processed by' : 'Confirmed by'), h('strong', null, hd.staff_name || hd.promoter_name), hd.staff_id ? h('div', { class: 'small muted' }, `${ROLE_NAMES[hd.staff_role] || ''}${hd.warehouse_name ? ` · ${hd.warehouse_name}` : ''}`) : h('div', { class: 'small muted' }, 'Promoter, in the app')),
            h('div', { class: 'arrow', 'aria-hidden': 'true' }, hd.kind === 'return' ? '←' : '→'),
            h('div', null, h('div', { class: 'label' }, 'Promoter'), h('strong', null, hd.promoter_name), hd.promoter_phone ? h('div', { class: 'small muted' }, hd.promoter_phone) : null),
          ),
          h('div', { class: 'small' }, h('strong', null, HANDOVER_NAMES[hd.kind]), ` · ${fmtDateTime(hd.created_at)}`, hd.uniform_clean !== null ? [' · Uniforms: ', uniformCheck(hd)] : null),
          hd.note ? h('div', { class: 'small muted' }, hd.note) : null,
          hd.signed ? h('img', { class: 'signature', src: `/api/handovers/${hd.id}/signature.png`, alt: `Signature of ${hd.promoter_name}` }) : h('div', { class: 'small muted' }, 'Not signed'),
        ),
      ),
    );
  }

  routes.handovers = async () => {
    let kind = '';
    const tabs = h('div', { class: 'tabs' });
    const out = h('div');
    const load = async () => {
      tabs.replaceChildren(
        ...[['', 'All'], ...Object.entries(HANDOVER_NAMES)].map(([k, label]) =>
          h('button', { class: k === kind ? 'active' : null, onclick: () => { kind = k; load(); } }, label),
        ),
      );
      const rows = await get(`/handovers${qs({ kind })}`);
      out.replaceChildren(
        table(
          [
            { label: 'When', render: (x) => fmtDateTime(x.created_at), class: 'nowrap' },
            { label: 'What', render: (x) => HANDOVER_NAMES[x.kind] },
            { label: 'Ref', render: (x) => h('span', { class: 'mono' }, x.request_ref || x.return_ref) },
            { label: 'Processed by', render: (x) => x.staff_name || h('span', { class: 'muted' }, 'Promoter (in app)') },
            { label: 'Promoter', key: 'promoter_name' },
            { label: 'Warehouse', render: (x) => x.warehouse_name || '—' },
            { label: 'Uniforms', render: uniformCheck },
            { label: 'Signed', render: (x) => (x.signed ? '✓' : '—') },
          ],
          rows,
          {
            empty: 'No handovers yet',
            onRow: (x) => modal(`${HANDOVER_NAMES[x.kind]} · ${x.request_ref || x.return_ref}`, h('div', null, handoverCards([x]), h('p', null, h('a', { href: x.request_id ? `#/requests/${x.request_id}` : '#/returns' }, 'Open the record →')))),
          },
        ),
      );
    };
    await load();
    return page(
      'Handover log',
      null,
      h('div', { class: 'card' }, h('p', { class: 'muted small', style: 'margin-top:0' }, 'Every time stock changes hands: which staff member processed it, which promoter received or returned it, their signature and the uniform check.'), tabs, out),
    );
  };

  // ------------------------------------------------------------------ promoter counter

  routes.counter = async (id) => {
    if (!id) {
      const promoters = (await get('/users?role=promoter')).filter((u) => u.active);
      const search = input({ type: 'search', placeholder: 'Search promoter by name or phone…' });
      const list = h('div', { class: 'list' });
      const draw = () => {
        const q = search.value.toLowerCase();
        list.replaceChildren(
          ...promoters
            .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.phone || '').replace(/\s/g, '').includes(q.replace(/\s/g, '')))
            .map((p) => h('div', { class: 'list-item clickable', onclick: () => go(`counter/${p.id}`) }, h('div', null, h('strong', null, p.name), h('div', { class: 'small muted' }, [p.region, p.phone].filter(Boolean).join(' · '))), h('span', { class: 'muted' }, '›'))),
        );
      };
      search.addEventListener('input', draw);
      draw();
      return page(
        'Promoter counter',
        null,
        h(
          'div',
          { class: 'card counter-start' },
          h('h2', null, 'Who is at the counter?'),
          h('p', { class: 'muted' }, 'Scan the QR code on the promoter’s ID badge (or on their phone under “My ID badge”).'),
          h('button', { class: 'big', onclick: () => scanner(async (code) => {
            const res = await get(`/scan${qs({ code })}`);
            if (res.kind !== 'promoter') throw new Error('That is not a promoter badge');
            go(`counter/${res.promoter.id}`);
          }, { title: 'Scan promoter badge' }) }, '⌗ Scan promoter badge'),
          h('div', { class: 'or' }, 'or find them'),
          search,
          h('div', { style: 'margin-top:10px' }, list),
        ),
      );
    }

    const d = await get(`/counter/${id}`);
    const p = d.promoter;
    const myWh = state.user.warehouse_id;
    const reload = () => render();
    const ready = d.ready.filter((r) => ['approved', 'picking'].includes(r.status));
    const transit = d.ready.filter((r) => r.status === 'dispatched');
    const initials = p.name.split(' ').map((x) => x[0]).join('').slice(0, 2);
    return page(
      'Promoter counter',
      [h('a', { class: 'btn secondary', href: '#/counter' }, '← Next promoter')],
      h(
        'div',
        { class: 'card session' },
        h(
          'div',
          { class: 'session-row' },
          h('div', { class: 'person staff' }, h('div', { class: 'label' }, 'Processed by (you)'), h('strong', null, state.user.name), h('div', { class: 'small muted' }, ROLE_NAMES[role()])),
          h('div', { class: 'arrow', 'aria-hidden': 'true' }, '⇄'),
          h(
            'div',
            { class: 'person promoter' },
            h('div', { class: 'avatar' }, initials),
            h('div', null, h('div', { class: 'label' }, 'Promoter'), h('strong', { class: 'big-name' }, p.name), h('div', { class: 'small muted' }, [p.phone, p.region].filter(Boolean).join(' · ')), p.uniform_size ? h('div', { class: 'small' }, `Uniform: ${GENDER_NAMES[p.gender] || ''} ${p.uniform_size}`) : null),
          ),
        ),
        p.active ? null : h('div', { class: 'error-text' }, 'This promoter account is deactivated.'),
      ),
      h(
        'div',
        { class: 'grid two' },
        h(
          'div',
          { class: 'card' },
          h('h2', null, `Ready to collect (${ready.length})`),
          ready.length
            ? h('div', { class: 'list' }, ready.map((r) => h('div', { class: 'list-item clickable', onclick: () => go(`requests/${r.id}`) }, h('div', null, h('strong', { class: 'mono' }, r.ref), ' · ', r.campaign_name, h('div', { class: 'small muted' }, `${r.warehouse_name}${myWh && r.warehouse_id !== myWh ? ' (another warehouse)' : ''} · ${DELIVERY[r.delivery_method]}${r.needed_by ? ` · needed ${fmtDate(r.needed_by)}` : ''}`)), h('span', { class: 'btn small' }, 'Issue →'))))
            : h('div', { class: 'empty' }, 'Nothing approved for this promoter'),
          transit.length ? [h('h3', { style: 'margin-top:14px' }, 'On the way to them'), h('div', { class: 'list' }, transit.map((r) => h('div', { class: 'list-item clickable', onclick: () => go(`requests/${r.id}`) }, h('div', null, h('strong', { class: 'mono' }, r.ref), ` · ${r.waybill ? `waybill ${r.waybill}` : DELIVERY[r.delivery_method]}`), badge(r.status))))] : null,
        ),
        h(
          'div',
          { class: 'card' },
          h('h2', null, 'Stock they hold'),
          table(
            [
              { label: 'Campaign', render: (x) => h('div', null, x.campaign_name, x.campaign_status === 'active' ? null : [' ', badge(x.campaign_status)]) },
              { label: 'Product', render: (x) => h('div', null, x.product_name, h('div', { class: 'small muted mono' }, x.sku)) },
              { label: 'Qty', num: true, render: (x) => num(x.qty) },
            ],
            d.holding,
            { empty: 'Holding nothing' },
          ),
          d.holding.length ? h('button', { style: 'margin-top:12px', onclick: () => counterReturn(p, d.holding, reload) }, 'Take a return') : null,
          d.pending_returns.length
            ? [h('h3', { style: 'margin-top:14px' }, 'Returns they logged'), h('div', { class: 'list' }, d.pending_returns.map((r) => h('div', { class: 'list-item clickable', onclick: () => returnDetail(r.id, reload) }, h('div', null, h('strong', { class: 'mono' }, r.ref), ` · ${r.campaign_name}`), h('span', { class: 'btn small' }, 'Check in →'))))]
            : null,
        ),
      ),
      d.handovers.length ? h('div', { class: 'card' }, h('h2', null, 'Recent handovers'), handoverCards(d.handovers.slice(0, 4))) : null,
    );
  };

  /** Promoter hands stock back at the counter: count it, sort uniforms, sign, done. */
  async function counterReturn(promoter, holding, done) {
    const whs = (await warehouses()).filter((w) => w.active);
    const camps = [...new Map(holding.map((x) => [x.campaign_id, x.campaign_name]))];
    const campSel = select(camps.map(([value, label]) => ({ value, label })), { value: camps.length === 1 ? camps[0][0] : '' }, 'Choose campaign…');
    const whSel = select(whs.map((w) => ({ value: w.id, label: w.name })), { value: state.user.warehouse_id || '' }, 'Into warehouse…');
    const rowsWrap = h('div');
    const inputs = new Map();
    const draw = () => {
      inputs.clear();
      const rows = holding.filter((x) => String(x.campaign_id) === campSel.value);
      const numIn = (v) => input({ type: 'number', min: '0', value: v, style: 'width:80px', inputmode: 'numeric' });
      rowsWrap.replaceChildren(
        rows.length
          ? table(
              [
                { label: 'Product', render: (x) => h('div', null, x.product_name, h('div', { class: 'small muted mono' }, x.sku)) },
                { label: 'Holding', num: true, render: (x) => num(x.qty) },
                { label: 'Good', num: true, render: (x) => { const i = { good: numIn(0), laundry: numIn(0), damaged: numIn(0), uniform: x.category === 'Uniform' }; inputs.set(x.product_id, i); return i.good; } },
                { label: 'Needs wash / iron', num: true, render: (x) => (x.category === 'Uniform' ? inputs.get(x.product_id).laundry : '—') },
                { label: 'Damaged', num: true, render: (x) => inputs.get(x.product_id).damaged },
              ],
              rows,
            )
          : h('div', { class: 'muted small' }, 'Choose the campaign the stock is from'),
      );
    };
    campSel.addEventListener('change', draw);
    draw();
    const sig = signaturePad('Promoter signs to confirm what they returned');
    const note = input({ placeholder: 'Note (optional)' });
    const save = h('button', { class: 'ok' }, 'Check in return');
    const m = modal(
      `Return from ${promoter.name}`,
      h(
        'div',
        null,
        h('div', { class: 'processing' }, `Processed by ${state.user.name} · Promoter: ${promoter.name}`),
        h('div', { class: 'form-grid' }, field('Campaign', campSel), field('Warehouse', whSel)),
        h('div', { style: 'margin-top:12px' }, rowsWrap),
        h('p', { class: 'hint' }, 'Uniforms that are not clean and ironed go to the laundry and can’t be issued until they’re done.'),
        sig.el,
        h('div', { style: 'margin-top:10px' }, note),
      ),
      [save],
      { wide: true },
    );
    save.onclick = () =>
      busy(save, async () => {
        const items = [...inputs]
          .map(([product_id, i]) => {
            const good = Number(i.good.value || 0);
            const laundry = i.uniform ? Number(i.laundry.value || 0) : 0;
            const damaged = Number(i.damaged.value || 0);
            return { product_id, qty: good + laundry + damaged, qty_good: good, qty_laundry: laundry, qty_damaged: damaged };
          })
          .filter((i) => i.qty > 0);
        if (!items.length) throw new Error('Enter what is being returned');
        const res = await post('/returns', {
          campaign_id: campSel.value,
          promoter_id: promoter.id,
          warehouse_id: whSel.value,
          receive_now: true,
          items,
          handover: { signature: sig.value(), note: note.value },
        });
        m.close();
        toast(`${res.ref} checked in`, 'ok');
        invalidate('products');
        done();
      });
  }

  // ------------------------------------------------------------------ deliveries & waybill photos

  routes.deliveries = async (id) => {
    if (id) return deliveryDetail(id);
    const whs = await warehouses();
    const search = input({ type: 'search', placeholder: 'Search reference, note or client…' });
    const whSel = select(whs.map((w) => ({ value: w.id, label: w.name })), { value: role() === 'warehouse' ? state.user.warehouse_id || '' : '' }, 'All warehouses');
    const missing = input({ type: 'checkbox' });
    const out = h('div');
    const load = async () => {
      const rows = await get(`/deliveries${qs({ q: search.value, warehouse_id: whSel.value, missing_photos: missing.checked ? '1' : '' })}`);
      out.replaceChildren(
        table(
          [
            { label: 'Received', render: (x) => fmtDateTime(x.received_at), class: 'nowrap' },
            { label: 'Reference', render: (x) => h('span', { class: 'mono' }, x.reference) },
            { label: 'Warehouse', key: 'warehouse_name' },
            { label: 'Clients', render: (x) => h('span', { class: 'small' }, x.clients) },
            { label: 'Units', num: true, render: (x) => num(x.units) },
            { label: 'Booked in by', key: 'received_by' },
            { label: 'Waybill photos', render: (x) => (x.photos ? badge('received', `📷 ${x.photos}`) : badge('pending', 'None yet')) },
          ],
          rows,
          { onRow: (x) => go(`deliveries/${x.warehouse_id}~${encodeURIComponent(x.reference)}`), empty: 'No deliveries match' },
        ),
      );
    };
    let t;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    whSel.addEventListener('change', load);
    missing.addEventListener('change', load);
    await load();
    return page(
      'Deliveries & waybills',
      [isOps() ? h('a', { class: 'btn', href: '#/receive' }, 'Receive a delivery') : null],
      h('div', { class: 'card' }, h('p', { class: 'muted small', style: 'margin-top:0' }, 'Every delivery booked into a warehouse. Open one to add photos of the waybill, delivery note or any damage.'), h('div', { class: 'filters' }, search, whSel, h('label', { class: 'check' }, missing, 'Missing photos only')), out),
    );
  };

  async function deliveryDetail(id) {
    const [wh, ...rest] = id.split('~');
    const reference = decodeURIComponent(rest.join('~'));
    const d = await get(`/deliveries/detail${qs({ reference, warehouse_id: wh })}`);
    const units = d.lines.reduce((s, l) => s + l.qty, 0);
    return page(
      h('span', null, 'Delivery ', h('span', { class: 'mono' }, d.reference)),
      [h('a', { class: 'btn secondary', href: '#/deliveries' }, '← Deliveries')],
      h(
        'div',
        { class: 'card' },
        h('dl', { class: 'dl' },
          h('dt', null, 'Warehouse'), h('dd', null, d.warehouse.name),
          h('dt', null, 'Received'), h('dd', null, `${fmtDateTime(d.lines[0].created_at)} by ${d.lines[0].received_by}`),
          h('dt', null, 'Units'), h('dd', null, num(units)),
          d.lines[0].note ? [h('dt', null, 'Note'), h('dd', null, d.lines[0].note)] : null,
        ),
      ),
      h('div', { class: 'card' }, attachmentsPanel({ kind: 'receipt', reference: d.reference, warehouse_id: d.warehouse.id }, d.attachments, { canUpload: d.can_upload, title: 'Waybill & delivery photos', emptyText: 'No photos yet. Snap the waybill or delivery note.' })),
      h(
        'div',
        { class: 'card' },
        h('h2', null, 'What arrived'),
        table(
          [
            { label: 'Product', render: (x) => h('div', null, x.product_name, h('div', { class: 'small muted mono' }, x.sku)) },
            { label: 'Client', key: 'client_name' },
            { label: 'Batch', render: (x) => x.batch_no || '—' },
            { label: 'Expiry', render: (x) => (x.expiry_date ? fmtDate(x.expiry_date) : '—') },
            { label: 'Qty', num: true, render: (x) => num(x.qty) },
          ],
          d.lines,
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ expiry & laundry

  function daysBadge(days) {
    if (days < 0) return badge('rejected', `Expired ${-days}d ago`);
    if (days <= 14) return badge('pending', `${days} day${days === 1 ? '' : 's'} left`);
    return badge('approved', `${days} days left`);
  }

  routes.expiry = async () => {
    let days = 60;
    const tabs = h('div', { class: 'tabs' });
    const out = h('div');
    const load = async () => {
      tabs.replaceChildren(...[[30, 'Next 30 days'], [60, '60 days'], [180, '6 months'], [3650, 'All dated stock']].map(([d, label]) => h('button', { class: d === days ? 'active' : null, onclick: () => { days = d; load(); } }, label)));
      const rows = await get(`/stock/expiry${qs({ days })}`);
      const expiredGroups = new Map();
      for (const r of rows.filter((x) => x.days_left < 0)) expiredGroups.set(`${r.product_id}-${r.warehouse_id}`, r);
      out.replaceChildren(
        expiredGroups.size && isOps()
          ? h('div', { class: 'alert-box' }, h('strong', null, 'Expired stock is never dispatched. '), 'Write it off once it has been disposed of or sent back to the client.',
              h('div', { class: 'list', style: 'margin-top:10px' }, [...expiredGroups.values()].map((r) => h('div', { class: 'list-item' }, h('div', null, `${r.sku} · ${r.product_name}`, h('div', { class: 'small muted' }, r.warehouse_name)), h('button', { class: 'danger small', onclick: (e) => busy(e.target, async () => {
                if (!confirm(`Write off all expired ${r.sku} at ${r.warehouse_name}?`)) return;
                const res = await post('/stock/write-off-expired', { product_id: r.product_id, warehouse_id: r.warehouse_id });
                toast(`${res.units} units written off`, 'ok');
                invalidate('products');
                load();
              }) }, 'Write off expired'))))) : null,
        table(
          [
            { label: 'Product', render: (x) => h('div', null, x.product_name, h('div', { class: 'small muted' }, `${x.sku} · ${x.client_name}`)) },
            { label: 'Warehouse', key: 'warehouse_name' },
            { label: 'Batch', render: (x) => h('span', { class: 'mono small' }, x.batch_no) },
            { label: 'Expires', render: (x) => fmtDate(x.expiry_date), class: 'nowrap' },
            { label: 'Status', render: (x) => daysBadge(x.days_left) },
            { label: 'Qty', num: true, render: (x) => num(x.qty) },
            canSeeCost() ? { label: 'Value', num: true, render: (x) => money(x.qty * x.unit_cost) } : null,
          ].filter(Boolean),
          rows,
          { empty: 'Nothing expires in this period', rowClass: (x) => (x.days_left < 0 ? 'low' : '') },
        ),
      );
    };
    await load();
    return page(
      'Expiry dates',
      null,
      h('div', { class: 'card' }, h('p', { class: 'muted small', style: 'margin-top:0' }, 'Dated stock (samples, consumables) is tracked by batch. Dispatches always take the batch that expires first.'), tabs, out),
    );
  };

  routes.laundry = async () => {
    const rows = await get('/stock/laundry');
    const inputs = new Map();
    const out = table(
      [
        { label: 'Item', render: (x) => h('div', null, x.product_name, h('div', { class: 'small muted mono' }, x.sku)) },
        { label: 'Warehouse', key: 'warehouse_name' },
        { label: 'At laundry', num: true, render: (x) => num(x.qty) },
        {
          label: 'Now clean & ironed',
          num: true,
          render: (x) => {
            const el = input({ type: 'number', min: '0', max: String(x.qty), value: x.qty, style: 'width:90px' });
            inputs.set(x, el);
            return el;
          },
        },
      ],
      rows,
      { empty: 'Nothing waiting for the laundry 👕' },
    );
    const save = h('button', { class: 'ok' }, 'Back into stock');
    save.onclick = () =>
      busy(save, async () => {
        const items = [...inputs].map(([x, el]) => ({ product_id: x.product_id, warehouse_id: x.warehouse_id, qty: Number(el.value) })).filter((i) => i.qty > 0);
        if (!items.length) throw new Error('Nothing selected');
        await post('/stock/laundry/clean', { items });
        toast('Uniforms back in stock', 'ok');
        invalidate('products');
        render();
      });
    return page(
      'Laundry',
      null,
      h('div', { class: 'card' }, h('p', { class: 'muted small', style: 'margin-top:0' }, 'Uniforms returned dirty or creased. Once washed and ironed, put them back into stock so they can be issued again.'), out, rows.length ? h('div', { style: 'margin-top:14px' }, save) : null),
    );
  };

  // ------------------------------------------------------------------ uniforms

  routes.uniforms = async () => {
    const rows = await get('/products?category=Uniform');
    const styles = [...new Map(rows.map((r) => [`${r.client_id}|${r.style || r.name}`, { key: `${r.client_id}|${r.style || r.name}`, label: `${r.style || r.name} · ${r.client_name}` }])).values()];
    const styleSel = select(styles.map((s) => ({ value: s.key, label: s.label })), { value: styles[0] ? styles[0].key : '' });
    const out = h('div');
    const draw = () => {
      const items = rows.filter((r) => `${r.client_id}|${r.style || r.name}` === styleSel.value);
      const sizes = [...new Set(items.map((r) => r.size || '—'))].sort((a, b) => sizeOrder(a) - sizeOrder(b));
      const cols = [...new Set(items.map((r) => `${GENDER_NAMES[r.gender] || ''} ${r.colour || ''}`.trim()))].sort();
      const cell = (size, col) => items.find((r) => (r.size || '—') === size && `${GENDER_NAMES[r.gender] || ''} ${r.colour || ''}`.trim() === col);
      out.replaceChildren(
        items.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'matrix' },
              h('thead', null, h('tr', null, h('th', null, 'Size'), cols.map((c) => h('th', { class: 'num' }, c)))),
              h('tbody', null, sizes.map((size) => h('tr', null, h('th', null, size), cols.map((c) => {
                const r = cell(size, c);
                if (!r) return h('td', { class: 'num muted' }, '—');
                const low = r.reorder_level && r.available <= r.reorder_level;
                return h('td', { class: `num clickable${low ? ' low' : ''}`, title: `${r.sku}: ${r.on_hand} on hand, ${r.allocated} allocated, ${r.in_field} with promoters, ${r.in_laundry} at laundry`, onclick: () => productDetail(r.id) },
                  h('strong', null, num(r.available)),
                  r.in_field || r.in_laundry ? h('div', { class: 'small muted' }, [r.in_field ? `${r.in_field} out` : '', r.in_laundry ? `${r.in_laundry} wash` : ''].filter(Boolean).join(' · ')) : null);
              })))),
            ))
          : h('div', { class: 'empty' }, 'No uniforms yet'),
        h('p', { class: 'hint' }, 'Numbers are available to issue (on hand minus already allocated). Orange cells are at or below the reorder level. Click a cell for details.'),
      );
    };
    styleSel.addEventListener('change', draw);
    draw();
    return page(
      'Uniforms',
      [isMgmt() || role() === 'account_manager' ? h('button', { onclick: () => rangeForm(() => render()) }, 'New uniform range') : null],
      h('div', { class: 'card' }, h('div', { class: 'filters' }, styleSel), out),
    );
  };

  async function rangeForm(done) {
    const [cls, sizes] = await Promise.all([clients(), get('/products/sizes')]);
    const mine = role() === 'account_manager' ? cls.filter((c) => c.account_manager_id === state.user.id) : cls;
    const style = input({ placeholder: 'e.g. JR promoter golf shirt' });
    const prefix = input({ placeholder: 'e.g. JRU-POLO', maxlength: '20' });
    const client = select(mine.map((c) => ({ value: c.id, label: c.name })), { value: (mine.find((c) => c.is_house) || {}).id || '' }, 'Choose client…');
    const colours = input({ placeholder: 'Comma separated, e.g. Black, White' });
    const genderBoxes = ['female', 'male', 'unisex'].map((g) => ({ g, el: input({ type: 'checkbox', checked: g !== 'unisex' }) }));
    const sizeBoxes = sizes.map((sz) => ({ sz, el: input({ type: 'checkbox', checked: ['S', 'M', 'L', 'XL'].includes(sz) }) }));
    const cost = input({ type: 'number', min: '0', step: '0.01' });
    const reorder = input({ type: 'number', min: '0', step: '1', value: 3 });
    const preview = h('div', { class: 'hint' });
    const update = () => {
      const n = genderBoxes.filter((b) => b.el.checked).length * sizeBoxes.filter((b) => b.el.checked).length * colours.value.split(',').filter((c) => c.trim()).length;
      preview.textContent = n ? `Creates ${n} SKUs, e.g. ${(prefix.value || 'PREFIX').toUpperCase()}-F-${(colours.value.split(',')[0] || 'BLACK').trim().toUpperCase()}-M` : '';
    };
    [prefix, colours, ...genderBoxes.map((b) => b.el), ...sizeBoxes.map((b) => b.el)].forEach((el) => el.addEventListener('input', update));
    const save = h('button', null, 'Create range');
    const m = modal(
      'New uniform range',
      h(
        'div',
        { class: 'form-grid' },
        field('Style name', style),
        field('SKU prefix', prefix),
        field('Client', client, { hint: 'Use JR Promotions (company stock) for JR’s own uniforms' }),
        field('Colours', colours),
        field('Cut', h('div', { class: 'checks' }, genderBoxes.map((b) => h('label', { class: 'check' }, b.el, GENDER_NAMES[b.g])))),
        field('Sizes', h('div', { class: 'checks' }, sizeBoxes.map((b) => h('label', { class: 'check' }, b.el, b.sz))), { full: true }),
        field('Unit cost (R)', cost),
        field('Reorder level (each)', reorder),
        h('div', { class: 'field full' }, preview),
      ),
      [save],
    );
    save.onclick = () =>
      busy(save, async () => {
        const res = await post('/products/range', {
          style: style.value,
          sku_prefix: prefix.value,
          client_id: client.value,
          colours: colours.value,
          genders: genderBoxes.filter((b) => b.el.checked).map((b) => b.g),
          sizes: sizeBoxes.filter((b) => b.el.checked).map((b) => b.sz),
          unit_cost: cost.value,
          reorder_level: reorder.value,
        });
        invalidate('products');
        m.close();
        toast(`${res.created.length} uniform SKUs created${res.skipped.length ? `, ${res.skipped.length} already existed` : ''}`, 'ok');
        if (done) done();
      });
  }

  // ------------------------------------------------------------------ kits

  routes.kits = async () => {
    const kits = await get('/kits?all=1');
    const canEdit = isOps();
    return page(
      'Kits & setups',
      [canEdit ? h('button', { onclick: () => kitForm() }, 'New kit') : null],
      h('p', { class: 'muted', style: 'margin-top:-8px' }, 'Standard sets (tables, cloths, gazebos, coolers…) that can be added to a stock request in one click.'),
      kits.length
        ? h('div', { class: 'grid two' }, kits.map((k) => h('div', { class: `card${canEdit ? ' clickable' : ''}`, onclick: canEdit ? () => kitForm(k) : null },
            h('h2', null, k.name, k.active ? null : [' ', badge('cancelled', 'inactive')]),
            k.description ? h('p', { class: 'muted small', style: 'margin-top:-6px' }, k.description) : null,
            h('ul', { class: 'kit-items' }, k.items.map((i) => h('li', null, h('strong', null, `${i.qty} ×`), ` ${i.product_name}`, h('span', { class: 'muted small' }, ` · ${i.category}`)))),
          )))
        : h('div', { class: 'card empty' }, 'No kits yet'),
    );
  };

  async function kitForm(k) {
    const prods = await products();
    const name = input({ value: k ? k.name : '' });
    const desc = input({ value: k ? k.description || '' : '' });
    const active = input({ type: 'checkbox', checked: k ? !!k.active : true });
    const lines = linesEditor(productOptions(prods), { initial: k ? k.items.map((i) => ({ product_id: i.product_id, qty: i.qty })) : [] });
    const save = h('button', null, 'Save kit');
    const m = modal(k ? k.name : 'New kit', h('div', null, h('div', { class: 'form-grid' }, field('Kit name', name), field('Description', desc), h('label', { class: 'check field full' }, active, 'Active')), h('h3', { style: 'margin-top:14px' }, 'Contents'), lines.el), [save]);
    save.onclick = () =>
      busy(save, async () => {
        const body = { name: name.value, description: desc.value, active: active.checked, items: lines.values().map((l) => ({ product_id: l.product_id, qty: l.qty })) };
        if (k) await put(`/kits/${k.id}`, body);
        else await post('/kits', body);
        m.close();
        toast('Kit saved', 'ok');
        render();
      });
  }

  // ------------------------------------------------------------------ QR labels & badges

  routes.labels = async () => {
    const [prods, batches] = await Promise.all([get('/products'), get('/stock/expiry?days=3650')]);
    const search = input({ type: 'search', placeholder: 'Filter products…' });
    const copies = new Map();
    const batchPick = new Map();
    const list = h('div');
    const draw = () => {
      const q = search.value.toLowerCase();
      const rows = prods.filter((p) => !q || `${p.sku} ${p.name} ${p.client_name}`.toLowerCase().includes(q));
      list.replaceChildren(
        table(
          [
            { label: 'Product', render: (x) => h('div', null, x.name, h('div', { class: 'small muted' }, `${x.sku} · ${x.client_name}`)) },
            { label: 'Category', key: 'category' },
            {
              label: 'Labels',
              num: true,
              render: (x) => {
                const el = input({ type: 'number', min: '0', value: copies.get(x.id) || '', placeholder: '0', style: 'width:80px' });
                el.addEventListener('input', () => copies.set(x.id, Number(el.value) || 0));
                return el;
              },
            },
          ],
          rows,
        ),
      );
    };
    search.addEventListener('input', draw);
    draw();
    const batchList = batches.length
      ? table(
          [
            { label: 'Batch', render: (x) => h('div', null, `${x.sku} · ${x.batch_no}`, h('div', { class: 'small muted' }, `${x.warehouse_name} · exp ${fmtDate(x.expiry_date)}`)) },
            { label: 'Qty', num: true, render: (x) => num(x.qty) },
            { label: 'Labels', num: true, render: (x) => { const el = input({ type: 'number', min: '0', placeholder: '0', style: 'width:80px' }); el.addEventListener('input', () => batchPick.set(x.id, { ...x, n: Number(el.value) || 0 })); return el; } },
          ],
          batches,
        )
      : h('div', { class: 'muted small' }, 'No dated batches in stock');
    const sheet = h('div', { class: 'label-sheet print-area' });
    const build = () => {
      const labels = [];
      for (const p of prods) for (let i = 0; i < (copies.get(p.id) || 0); i++) labels.push({ code: `JRP:${p.sku}`, sku: p.sku, name: p.name, extra: [p.client_name, p.bin].filter(Boolean).join(' · ') });
      for (const b of batchPick.values()) for (let i = 0; i < b.n; i++) labels.push({ code: `JRP:${b.sku}:${b.batch_no}`, sku: b.sku, name: b.product_name, extra: `Batch ${b.batch_no} · EXP ${b.expiry_date}` });
      if (!labels.length) return toast('Enter how many labels you need', 'error');
      if (labels.length > 600) return toast('That is a lot of labels; print in batches of 600 or less', 'error');
      sheet.replaceChildren(...labels.map((l) => h('div', { class: 'qr-label' }, qrImg(l.code, 96), h('div', null, h('div', { class: 'mono' }, l.sku), h('div', { class: 'label-name' }, l.name), h('div', { class: 'small' }, l.extra)))));
      setTimeout(() => window.print(), 300);
    };
    return page(
      'QR labels',
      [h('button', { onclick: build }, 'Print labels')],
      h('div', { class: 'no-print' },
        h('div', { class: 'card' }, h('p', { class: 'muted small', style: 'margin-top:0' }, 'Print QR labels for shelves, boxes and individual items. Scanning a label opens the product, adds it when receiving, and ticks it off when picking. Prints 3 across on A4 (fits 63×38 mm label sheets).'), h('div', { class: 'filters' }, search), list),
        h('div', { class: 'card' }, h('h2', null, 'Batch labels (dated stock)'), batchList),
      ),
      sheet,
    );
  };

  routes.badges = async () => {
    const promoters = (await get('/users?role=promoter')).filter((u) => u.active);
    const picked = new Set(promoters.map((p) => p.id));
    const sheet = h('div', { class: 'badge-sheet print-area' });
    const draw = () =>
      sheet.replaceChildren(
        ...promoters.filter((p) => picked.has(p.id)).map((p) =>
          h('div', { class: 'id-badge' }, h('div', { class: 'id-head' }, h('span', { class: 'mark' }, 'JR'), 'JR Promotions · Promoter'), h('div', { class: 'id-body' }, qrImg(`JRU:${p.badge_code}`, 120), h('div', null, h('div', { class: 'id-name' }, p.name), h('div', { class: 'small' }, p.region || ''), h('div', { class: 'small' }, p.phone || ''), p.uniform_size ? h('div', { class: 'small' }, `Uniform: ${GENDER_NAMES[p.gender] || ''} ${p.uniform_size}`) : null))),
        ),
      );
    draw();
    return page(
      'Promoter ID badges',
      [h('button', { onclick: () => window.print() }, 'Print badges')],
      h(
        'div',
        { class: 'card no-print' },
        h('p', { class: 'muted small', style: 'margin-top:0' }, 'Each promoter’s badge QR identifies them at the warehouse counter. Promoters also have it on their phone under “My ID badge”. If a badge is lost, reissue it in Staff & users; the old code stops working.'),
        h('div', { class: 'checks' }, promoters.map((p) => {
          const box = input({ type: 'checkbox', checked: true });
          box.addEventListener('change', () => { if (box.checked) picked.add(p.id); else picked.delete(p.id); draw(); });
          return h('label', { class: 'check' }, box, p.name);
        })),
      ),
      sheet,
    );
  };

  routes.badge = async () => {
    const me = await get('/auth/me');
    return page(
      'My ID badge',
      null,
      h(
        'div',
        { class: 'card my-badge' },
        h('div', { class: 'id-head' }, h('span', { class: 'mark' }, 'JR'), 'JR Promotions · Promoter'),
        qrImg(`JRU:${me.badge_code}`, 240),
        h('div', { class: 'id-name' }, me.name),
        h('div', { class: 'muted' }, [me.region, me.uniform_size ? `Uniform ${GENDER_NAMES[me.gender] || ''} ${me.uniform_size}` : null].filter(Boolean).join(' · ')),
        h('p', { class: 'hint' }, 'Show this at the warehouse counter when you collect or return stock. Turn your screen brightness up if it doesn’t scan.'),
      ),
    );
  };

  // ------------------------------------------------------------------ campaign stock plan

  function planCard(c, canManage) {
    const rows = c.plan || [];
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'page-head', style: 'margin-bottom:8px' }, h('h2', { style: 'margin:0' }, 'Stock plan'), canManage ? h('button', { class: 'secondary small', onclick: () => planForm(c) }, rows.length ? 'Edit plan' : 'Plan stock') : null),
      h('p', { class: 'muted small', style: 'margin-top:0' }, 'What this campaign needs in total. Outstanding = planned − sent − approved but not yet sent.'),
      table(
        [
          { label: 'Product', render: (x) => h('div', null, x.product_name, h('div', { class: 'small muted' }, `${x.sku} · ${x.category}`)) },
          { label: 'Planned', num: true, render: (x) => num(x.planned_qty) },
          { label: 'Sent', num: true, render: (x) => num(x.dispatched) },
          { label: 'Approved', num: true, render: (x) => num(x.approved) },
          { label: 'Awaiting approval', num: true, render: (x) => num(x.requested) },
          { label: 'Outstanding', num: true, render: (x) => (x.outstanding ? h('strong', { class: x.outstanding > x.on_hand ? 'text-danger' : '' }, num(x.outstanding)) : '✓') },
          { label: 'In warehouses', num: true, render: (x) => num(x.on_hand) },
        ],
        rows,
        { empty: 'No stock planned yet' },
      ),
    );
  }

  async function planForm(c) {
    const prods = await get(`/campaigns/${c.id}/products`);
    const current = new Map((c.plan || []).map((p) => [p.product_id, p.planned_qty]));
    const inputs = new Map();
    const body = table(
      [
        { label: 'Product', render: (x) => h('div', null, x.name, h('div', { class: 'small muted' }, `${x.sku} · ${x.category}${x.is_house ? ' · JR stock' : ''}`)) },
        { label: 'Free now', num: true, render: (x) => num(x.availability.reduce((s, a) => s + a.available, 0)) },
        { label: 'Planned', num: true, render: (x) => { const el = input({ type: 'number', min: '0', value: current.get(x.id) || '', placeholder: '0', style: 'width:100px' }); inputs.set(x.id, el); return el; } },
      ],
      prods,
    );
    const save = h('button', null, 'Save plan');
    const m = modal(`Stock plan · ${c.name}`, body, [save], { wide: true });
    save.onclick = () =>
      busy(save, async () => {
        await put(`/campaigns/${c.id}/plan`, { items: [...inputs].map(([product_id, el]) => ({ product_id, planned_qty: Number(el.value || 0) })).filter((i) => i.planned_qty > 0) });
        m.close();
        toast('Plan saved', 'ok');
        render();
      });
  }

  // ------------------------------------------------------------------ boot

  (async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (res.ok) {
        state.user = await res.json();
        return render();
      }
    } catch {
      /* fall through to login */
    }
    renderLogin();
  })();
})();
