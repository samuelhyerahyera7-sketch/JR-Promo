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
  };
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

  function modal(title, body, buttons = []) {
    const onKey = (e) => e.key === 'Escape' && close();
    const close = () => {
      back.remove();
      document.removeEventListener('keydown', onKey);
    };
    document.addEventListener('keydown', onKey);
    const back = h(
      'div',
      { class: 'modal-back', onmousedown: (e) => e.target === back && close() },
      h(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
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
   * Editable list of product lines. `products` is [{id, label, group?, hint?}];
   * returns {el, values()} where values() gives [{product_id, qty, bin?}].
   */
  function linesEditor(products, { withBin = false, qtyLabel = 'Qty', initial = [] } = {}) {
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
    const addLine = (pre = {}) => {
      const sel = select(grouped, { value: pre.product_id ?? '' }, 'Choose product…');
      const hint = h('div', { class: 'hint' });
      const showHint = () => (hint.textContent = hints.get(sel.value) || '');
      sel.addEventListener('change', showHint);
      showHint();
      const qty = input({ type: 'number', min: '1', step: '1', placeholder: qtyLabel, value: pre.qty ?? '', inputmode: 'numeric' });
      const bin = withBin ? input({ placeholder: 'Bin', class: 'bin', maxlength: '30' }) : null;
      const row = h(
        'div',
        { class: `line${withBin ? ' with-bin' : ''}` },
        h('div', null, sel, hint),
        qty,
        bin,
        h('button', { type: 'button', class: 'secondary', title: 'Remove line', onclick: () => row.remove() }, '×'),
      );
      row._get = () => ({ product_id: Number(sel.value), qty: Number(qty.value), bin: bin ? bin.value : undefined });
      wrap.append(row);
    };
    const el = h(
      'div',
      null,
      wrap,
      h('button', { type: 'button', class: 'secondary small', style: 'margin-top:8px', onclick: () => addLine() }, '+ Add product'),
    );
    if (initial.length) initial.forEach(addLine);
    else addLine();
    const values = () =>
      [...wrap.children].map((r) => r._get()).filter((l) => l.product_id || l.qty);
    el.refreshHints = (fn) => {
      for (const p of products) hints.set(String(p.id), fn(p));
      wrap.querySelectorAll('select').forEach((s) => s.dispatchEvent(new Event('change')));
    };
    return { el, values };
  }

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
    const items = [{ group: null, route: 'dashboard', label: 'Dashboard' }];
    if (r === 'promoter') {
      items.push(
        { route: 'my-stock', label: 'My stock' },
        { route: 'requests', label: 'Stock requests', count: state.counts.to_confirm },
        { route: 'usage', label: 'Activation reports' },
        { route: 'returns', label: 'Returns' },
        { route: 'campaigns', label: 'My campaigns' },
      );
      return items;
    }
    items.push({ group: 'Operations' });
    items.push({
      route: 'requests',
      label: r === 'warehouse' ? 'Dispatch queue' : 'Stock requests',
      count: r === 'warehouse' ? state.counts.to_dispatch : state.counts.pending_approval,
    });
    items.push({ route: 'returns', label: 'Returns', count: r === 'warehouse' ? state.counts.pending_returns : null });
    if (r !== 'warehouse') items.push({ route: 'campaigns', label: 'Campaigns' }, { route: 'usage', label: 'Activation reports' });
    items.push({ group: 'Stock' }, { route: 'stock', label: 'Stock on hand' }, { route: 'field', label: 'Stock with promoters' });
    if (isOps()) {
      items.push({ route: 'receive', label: 'Receive stock' }, { route: 'transfer', label: 'Transfer' }, { route: 'count', label: 'Stock take' });
    }
    items.push({ route: 'movements', label: 'Stock ledger' });
    if (r === 'warehouse') items.push({ route: 'campaigns', label: 'Campaigns' });
    if (r !== 'warehouse') {
      items.push({ group: 'Setup' }, { route: 'clients', label: 'Clients' });
      if (isMgmt()) items.push({ route: 'warehouses', label: 'Warehouses' });
      if (r === 'director') items.push({ route: 'users', label: 'Staff & users' });
    }
    return items;
  }

  const routes = {};
  let currentMain = null;

  function parseHash() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    return { name: parts[0] || 'dashboard', id: parts[1] };
  }
  const go = (path) => {
    if (location.hash === `#/${path}`) render();
    else location.hash = `#/${path}`;
  };

  async function refreshCounts() {
    try {
      const d = await get('/dashboard');
      state.counts = d.kpis || {};
      state.lastDashboard = d;
    } catch {
      /* counts are cosmetic */
    }
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
    document.querySelectorAll('.modal-back').forEach((m) => m.remove());
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
        r === 'account_manager' || isMgmt() ? h('button', { class: 'secondary', onclick: () => requestForm() }, 'New stock request') : null,
      ],
      kpis,
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
                    h('button', { class: 'ok small', onclick: (e) => busy(e.target, async () => {
                      await post(`/requests/${r.id}/deliver`);
                      toast('Delivery confirmed', 'ok');
                      state.lastDashboard = null;
                      render();
                    }) }, 'Received')),
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
    const filters = { q: '', client_id: '', category: '', low: '' };
    const search = input({ type: 'search', placeholder: 'Search SKU, name or barcode…' });
    const clientSel = select(cls.map((c) => ({ value: c.id, label: c.name })), {}, 'All clients');
    const catSel = select(cats.map((c) => ({ value: c, label: c })), {}, 'All categories');
    const lowBox = input({ type: 'checkbox' });
    const out = h('div');
    const activeWh = whs.filter((w) => w.active);

    const load = async () => {
      Object.assign(filters, { q: search.value, client_id: clientSel.value, category: catSel.value, low: lowBox.checked ? '1' : '' });
      const rows = await get(`/products${qs(filters)}`);
      const cols = [
        { label: 'SKU', render: (x) => h('span', { class: 'mono' }, x.sku) },
        { label: 'Product', render: (x) => h('div', null, x.name, h('div', { class: 'small muted' }, `${x.client_name} · ${x.category}`)) },
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
    [clientSel, catSel, lowBox].forEach((el) => el.addEventListener('change', load));
    await load();

    return page(
      'Stock on hand',
      [
        h('a', { class: 'btn secondary', href: `/api/stock/levels.csv`, onclick: (e) => { e.currentTarget.href = `/api/stock/levels.csv${qs(filters)}`; } }, 'Export CSV'),
        isMgmt() || role() === 'account_manager' ? h('button', { onclick: () => productForm(null, load) }, 'New product') : null,
      ],
      h('div', { class: 'card' }, h('div', { class: 'filters' }, search, clientSel, catSel, h('label', { class: 'check' }, lowBox, 'Low stock only')), out),
    );
  };

  async function productDetail(id) {
    const p = await busy(null, () => get(`/products/${id}`));
    if (!p) return;
    const canEdit = isMgmt() || role() === 'account_manager';
    const body = h(
      'div',
      null,
      h(
        'dl',
        { class: 'dl' },
        h('dt', null, 'SKU'), h('dd', { class: 'mono' }, p.sku),
        h('dt', null, 'Client'), h('dd', null, p.client_name),
        h('dt', null, 'Category'), h('dd', null, p.category),
        h('dt', null, 'Unit'), h('dd', null, p.unit),
        p.barcode ? [h('dt', null, 'Barcode'), h('dd', { class: 'mono' }, p.barcode)] : null,
        canSeeCost() ? [h('dt', null, 'Unit cost'), h('dd', null, money(p.unit_cost))] : null,
        h('dt', null, 'Reorder level'), h('dd', null, num(p.reorder_level)),
        h('dt', null, 'On hand / allocated'), h('dd', null, `${num(p.on_hand)} / ${num(p.allocated)}`),
      ),
      h('h3', { style: 'margin-top:18px' }, 'Warehouse levels'),
      table(
        [
          { label: 'Warehouse', key: 'warehouse_name' },
          { label: 'Bin', render: (x) => x.bin || '—' },
          { label: 'Qty', num: true, render: (x) => num(x.qty) },
        ],
        p.levels,
        { empty: 'Not stocked in any warehouse' },
      ),
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
      canEdit ? h('button', { class: 'secondary', onclick: () => { m.close(); productForm(p, () => render()); } }, 'Edit product') : null,
      h('button', { onclick: () => m.close() }, 'Close'),
    ].filter(Boolean));
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
      active: input({ type: 'checkbox', checked: p ? !!p.active : true }),
    };
    const save = h('button', null, p ? 'Save changes' : 'Create product');
    const m = modal(
      p ? `Edit ${p.sku}` : 'New product',
      h(
        'div',
        { class: 'form-grid' },
        field('SKU', f.sku),
        field('Name', f.name),
        field('Client', f.client_id),
        field('Category', f.category),
        field('Unit of measure', f.unit),
        field('Unit cost (R)', f.unit_cost, { hint: 'Used for stock valuation' }),
        field('Reorder level', f.reorder_level, { hint: 'Alert when total on hand drops to this' }),
        field('Barcode', f.barcode),
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
    return list.map((p) => ({ id: p.id, label: `${p.sku} · ${p.name}`, group: p.client_name, hint: hint ? hint(p) : '' }));
  }

  routes.receive = async () => {
    const [whs, prods] = await Promise.all([warehouses(), products()]);
    const wh = select(whs.filter((w) => w.active).map((w) => ({ value: w.id, label: `${w.name} (${w.city})` })), { value: state.user.warehouse_id || '' }, 'Choose warehouse…');
    const ref = input({ placeholder: 'Delivery note / GRN number', maxlength: '80' });
    const note = input({ placeholder: 'Supplier, condition, etc.' });
    const lines = linesEditor(productOptions(prods), { withBin: true });
    const save = h('button', null, 'Book stock in');
    save.onclick = () =>
      busy(save, async () => {
        await post('/stock/receive', { warehouse_id: wh.value, reference: ref.value, note: note.value, items: lines.values() });
        invalidate('products', 'warehouses');
        toast('Stock received', 'ok');
        go('stock');
      });
    return page(
      'Receive stock',
      null,
      h(
        'div',
        { class: 'card' },
        h('p', { class: 'muted small', style: 'margin-top:0' }, 'Book client or supplier deliveries into a warehouse. Each line is recorded on the stock ledger against the reference.'),
        h('div', { class: 'form-grid' }, field('Warehouse', wh), field('Reference', ref), field('Note', note, { full: true })),
        h('h3', { style: 'margin-top:18px' }, 'Products received'),
        lines.el,
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
    const order = ['pending', 'approved', 'picking', 'dispatched', 'delivered'];
    const idx = order.indexOf(q.status);
    const steps = ['rejected', 'cancelled'].includes(q.status)
      ? h('div', { class: 'steps' }, h('span', { class: 'done' }, 'Requested'), h('span', { class: 'current' }, q.status === 'rejected' ? 'Rejected' : 'Cancelled'))
      : h(
          'div',
          { class: 'steps' },
          ['Requested', 'Approved', 'Picking', 'Dispatched', 'Delivered'].map((label, i) =>
            h('span', { class: i < idx ? 'done' : i === idx ? 'current' : null }, label),
          ),
        );

    const approveInputs = new Map();
    const dispatchInputs = new Map();
    const mode = canManage && q.status === 'pending' ? 'approve' : isOps() && ['approved', 'picking'].includes(q.status) ? 'dispatch' : null;
    const items = table(
      [
        { label: 'Product', render: (x) => h('div', null, x.product_name, h('div', { class: 'small muted mono' }, x.sku)) },
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
          label: 'Dispatched',
          num: true,
          render: (x) => {
            if (mode !== 'dispatch') return x.qty_dispatched === null ? '—' : num(x.qty_dispatched);
            const el = input({ type: 'number', min: '0', max: String(x.qty_approved), value: x.qty_approved, style: 'width:100px' });
            dispatchInputs.set(x.id, el);
            return el;
          },
        },
      ].filter(Boolean),
      q.items,
    );

    const actions = h('div', { class: 'no-print', style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;align-items:end' });
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
      if (q.status === 'approved') {
        const pick = h('button', { class: 'secondary' }, 'Start picking');
        pick.onclick = () => busy(pick, async () => { await post(`/requests/${q.id}/pick`); reload(); });
        append(actions, pick);
      }
      const courier = input({ placeholder: 'Courier (e.g. The Courier Guy)' });
      const waybill = input({ placeholder: q.delivery_method === 'courier' ? 'Waybill number (required)' : 'Waybill / reference' });
      const dispatchBtn = h('button', null, 'Dispatch');
      dispatchBtn.onclick = () =>
        busy(dispatchBtn, async () => {
          await post(`/requests/${q.id}/dispatch`, {
            courier: courier.value,
            waybill: waybill.value,
            items: [...dispatchInputs].map(([itemId, el]) => ({ id: itemId, qty_dispatched: el.value })),
          });
          toast(`${q.ref} dispatched, stock moved to ${q.promoter_name}`, 'ok');
          reload();
        });
      append(
        actions,
        q.delivery_method === 'collect' ? null : h('div', { style: 'min-width:200px' }, courier),
        h('div', { style: 'min-width:200px' }, waybill),
        dispatchBtn,
        h('button', { class: 'secondary', onclick: () => window.print() }, 'Print picking slip'),
      );
    }
    if (q.status === 'dispatched' && ((r === 'promoter' && q.promoter_id === state.user.id) || isOps())) {
      const deliver = h('button', { class: 'ok' }, r === 'promoter' ? 'I have received this stock' : 'Mark as delivered');
      deliver.onclick = () => busy(deliver, async () => { await post(`/requests/${q.id}/deliver`); toast('Delivery confirmed', 'ok'); reload(); });
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

    return page(
      h('span', null, h('span', { class: 'mono' }, q.ref), ' ', badge(q.status)),
      [h('a', { class: 'btn secondary', href: '#/requests' }, '← All requests')],
      h(
        'div',
        { class: 'card' },
        steps,
        h(
          'div',
          { class: 'grid two' },
          h(
            'dl',
            { class: 'dl' },
            h('dt', null, 'Campaign'), h('dd', null, h('a', { href: `#/campaigns/${q.campaign_id}` }, q.campaign_name), ` · ${q.client_name}`),
            h('dt', null, 'Promoter'), h('dd', null, q.promoter_name, q.promoter_phone ? ` · ${q.promoter_phone}` : ''),
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
            q.dispatched_by_name ? [h('dt', null, 'Dispatched'), h('dd', null, `${q.dispatched_by_name}, ${fmtDateTime(q.dispatched_at)}`)] : null,
            q.waybill ? [h('dt', null, 'Waybill'), h('dd', { class: 'mono' }, `${q.courier ? `${q.courier} · ` : ''}${q.waybill}`)] : null,
            q.delivered_at ? [h('dt', null, 'Delivered'), h('dd', null, fmtDateTime(q.delivered_at))] : null,
            q.notes ? [h('dt', null, 'Notes'), h('dd', null, q.notes)] : null,
            q.decision_note ? [h('dt', null, 'Decision note'), h('dd', null, q.decision_note)] : null,
          ),
        ),
      ),
      h('div', { class: 'card' }, h('h2', null, 'Items'), items, actions),
    );
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
    let lines = null;
    let campProducts = [];
    const hintFor = (p) => {
      const a = p.availability.find((x) => String(x.warehouse_id) === whSel.value);
      return whSel.value ? `${num(a ? a.available : 0)} available in this warehouse` : p.availability.map((x) => `${x.warehouse_name}: ${num(x.available)}`).join(' · ');
    };
    campSel.addEventListener('change', async () => {
      if (!campSel.value) return;
      const [prods, detail] = await Promise.all([get(`/campaigns/${campSel.value}/products`), isPromoter ? null : get(`/campaigns/${campSel.value}`)]);
      campProducts = prods;
      if (detail) {
        promSel.replaceChildren(h('option', { value: '' }, detail.promoters.length ? 'Choose promoter…' : 'No promoters on this campaign'));
        for (const p of detail.promoters) promSel.append(h('option', { value: p.id }, `${p.name}${p.region ? ` (${p.region})` : ''}`));
      }
      lines = linesEditor(prods.map((p) => ({ id: p.id, label: `${p.sku} · ${p.name}`, hint: hintFor(p) })));
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
        h('h3', { style: 'margin-top:16px' }, 'Products'),
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
    const body = h(
      'div',
      null,
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
            label: 'Good',
            num: true,
            render: (x) => {
              if (!receiving) return x.qty_good === null ? '—' : num(x.qty_good);
              const good = input({ type: 'number', min: '0', value: x.qty, style: 'width:90px' });
              const bad = input({ type: 'number', min: '0', value: 0, style: 'width:90px' });
              inputs.set(x.id, { good, bad });
              return good;
            },
          },
          { label: 'Damaged', num: true, render: (x) => (receiving ? inputs.get(x.id).bad : x.qty_damaged === null ? '—' : num(x.qty_damaged)) },
        ],
        rt.items,
      ),
      receiving ? h('p', { class: 'hint' }, 'Good units go back into stock. Damaged units are written off. Anything not counted stays against the promoter.') : null,
    );
    const buttons = [];
    if (receiving) {
      const recv = h('button', { class: 'ok' }, 'Check in return');
      recv.onclick = () =>
        busy(recv, async () => {
          await post(`/returns/${rt.id}/receive`, { items: [...inputs].map(([itemId, i]) => ({ id: itemId, qty_good: i.good.value, qty_damaged: i.bad.value })) });
          m.close();
          toast(`${rt.ref} checked in`, 'ok');
          invalidate('products');
          state.lastDashboard = null;
          done && done();
        });
      buttons.push(recv);
    }
    if (rt.status === 'pending' && role() !== 'warehouse') {
      const cancel = h('button', { class: 'secondary' }, 'Cancel return');
      cancel.onclick = () => busy(cancel, async () => { await post(`/returns/${rt.id}/cancel`); m.close(); done && done(); });
      buttons.push(cancel);
    }
    const m = modal(`Return ${rt.ref}`, body, buttons);
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
      { label: 'Client', render: (x) => h('div', null, h('strong', null, x.name), x.active ? null : [' ', badge('cancelled', 'inactive')]) },
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
    };
    const save = h('button', null, c ? 'Save client' : 'Create client');
    const m = modal(
      c ? c.name : 'New client',
      h('div', { class: 'form-grid' }, field('Client / brand name', f.name, { full: true }), field('Contact person', f.contact_name), field('Contact email', f.contact_email), field('Contact phone', f.contact_phone), field('Account manager', f.account_manager_id), h('label', { class: 'check field full' }, f.active, 'Active')),
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
      password: input({ type: 'password', autocomplete: 'new-password', placeholder: u ? 'Leave blank to keep current' : 'At least 8 characters' }),
      active: input({ type: 'checkbox', checked: u ? !!u.active : true }),
    };
    const save = h('button', null, u ? 'Save user' : 'Create user');
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
        field(u ? 'Reset password' : 'Password', f.password),
        h('label', { class: 'check field full' }, f.active, 'Active (can sign in)'),
      ),
      [save],
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
