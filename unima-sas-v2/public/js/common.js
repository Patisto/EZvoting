(function () {
  const TOKEN_KEY = 'ems_token';
  const USER_KEY = 'ems_user';

  window.$ = (sel, root = document) => root.querySelector(sel);
  window.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  window.esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  window.initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }
  window.el = el;

  // ── Session (staff only) ──
  window.Session = {
    token: () => localStorage.getItem(TOKEN_KEY),
    user() {
      try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (_) { return null; }
    },
    set(token, user) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    },
    clear() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    },
  };

  // ── API ──
  window.api = async function (path, { method = 'GET', body, auth = false, token } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    else if (auth && Session.token()) headers.Authorization = 'Bearer ' + Session.token();

    let res;
    try {
      res = await fetch('/api' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (_) {
      throw new Error('Network error. Check your connection and try again.');
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* no body */ }

    if (res.status === 401 && auth) {
      Session.clear();
      location.href = '/login?next=' + encodeURIComponent(location.pathname);
      throw new Error((data && data.error) || 'Please log in again.');
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Something went wrong. Please try again.');
      err.status = res.status;
      throw err;
    }
    return data;
  };

  // ── Toast ──
  let toastTimer;
  window.toast = function (msg, type) {
    let t = $('#toast');
    if (!t) { t = el('div', 'toast'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = 'toast show' + (type === 'error' ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  };

  // ── Modal ──
  // actions: [{label, kind, value, run(bodyEl) -> false to stay open}]; resolves with the clicked action's value.
  window.modal = function ({ title, content, actions }) {
    return new Promise((resolve) => {
      const overlay = el('div', 'modal-overlay');
      const panel = el('div', 'modal-panel');
      panel.appendChild(el('h3', '', esc(title)));
      const body = el('div', 'modal-body');
      if (typeof content === 'string') body.innerHTML = content; else if (content) body.appendChild(content);
      const foot = el('div', 'modal-actions');
      panel.append(body, foot);
      overlay.appendChild(panel);

      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      function close(v) {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(v);
      }
      (actions || [{ label: 'Close', value: null }]).forEach((a) => {
        const b = el('button', 'btn ' + (a.kind || ''));
        b.type = 'button';
        b.textContent = a.label;
        b.addEventListener('click', async () => {
          if (a.run) {
            b.disabled = true;
            try {
              if ((await a.run(body)) === false) { b.disabled = false; return; }
            } catch (e) {
              toast(e.message, 'error');
              b.disabled = false;
              return;
            }
          }
          close(a.value === undefined ? true : a.value);
        });
        foot.appendChild(b);
      });
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
      const first = $('input, textarea, select', body);
      if (first) first.focus();
    });
  };

  window.confirmDialog = async function (title, message, { danger = false, confirmLabel = 'Confirm' } = {}) {
    const v = await modal({
      title,
      content: `<p>${message}</p>`,
      actions: [
        { label: 'Cancel', value: false },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', value: true },
      ],
    });
    return v === true;
  };

  // ── Misc ──
  const STATE_LABELS = {
    pending: 'Not started', open: 'Open', closed: 'Closed',
    draft: 'Draft', nominations: 'Nominations open', nominations_closed: 'Nominations closed',
    registration: 'Registration open', registration_closed: 'Registration closed',
    voting: 'Voting open', voting_closed: 'Voting closed', results: 'Results released',
  };
  window.chip = (state, label) => `<span class="chip ${esc(state)}">${esc(label || STATE_LABELS[state] || state)}</span>`;
  window.phaseChip = (phase) => {
    const cls = { voting: 'open', registration: 'open', nominations: 'open', results: 'results', voting_closed: 'closed', registration_closed: 'closed', nominations_closed: 'closed', draft: 'pending' }[phase] || '';
    return `<span class="chip ${cls}">${esc(STATE_LABELS[phase] || phase)}</span>`;
  };

  window.copyText = async function (text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied.');
    } catch (_) {
      const t = el('textarea'); t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); toast('Copied.'); } catch (e) { toast('Copy failed.', 'error'); }
      t.remove();
    }
  };

  window.downloadCSV = function (rows, filename) {
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const blob = new Blob(['\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  window.genPassword = function (len = 10) {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  };

  window.downloadJSON = function (data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  // Authenticated PDF: fetch with the bearer token (a plain <a> can't carry it) and save the blob.
  window.downloadPdf = async function (path, filename) {
    const headers = {};
    if (Session.token()) headers.Authorization = 'Bearer ' + Session.token();
    let res;
    try {
      res = await fetch('/api' + path, { headers });
    } catch (_) { throw new Error('Network error. Check your connection and try again.'); }
    if (!res.ok) {
      let msg = 'Please log in.';
      try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (_) {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = el('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  // Candidate photo that falls back to initials if the image fails to load.
  window.avatar = (c, cls = 'candidate-photo') => c.photo_url
    ? `<img class="${cls}" src="${esc(c.photo_url)}" alt="${esc(c.name)}" data-photo="${esc(c.photo_url)}" data-name="${esc(c.name)}" loading="lazy"/>`
    : `<div class="${cls}-placeholder">${esc(initials(c.name))}</div>`;

  // Open a candidate's photo full-size in a modal. Works for ballot photos and console thumbs.
  window.openPhoto = function (url, name) {
    return modal({
      title: name || 'Photo',
      content: `<div class="photo-viewer"><img src="${esc(url)}" alt="${esc(name)}"/></div>`,
      actions: [{ label: 'Close', kind: 'primary', value: true }],
    });
  };

  // CSP blocks inline onerror, so image failures are handled here (error doesn't bubble; use capture).
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.dataset.fallback !== undefined) {
      const ph = el('div', t.dataset.fallbackClass || 'candidate-photo-placeholder', esc(t.dataset.fallback));
      t.replaceWith(ph);
    }
  }, true);

  // Click any candidate photo to view it full-size.
  document.addEventListener('click', (e) => {
    const img = e.target.closest('img[data-photo]');
    if (img) openPhoto(img.dataset.photo, img.dataset.name || '');
  });

  // Results renderer shared by public results and the facilitator console.
  window.renderResults = function (container, results) {
    if (!results.positions.length) { container.innerHTML = '<p class="muted">No positions yet.</p>'; return; }
    container.innerHTML = results.positions.map((p) => `
      <div class="result-block">
        <div class="result-block-title">${esc(p.title)}</div>
        ${p.slots.map((s) => {
          const max = Math.max(1, ...s.candidates.map((c) => c.votes));
          const top = s.candidates.length && s.candidates[0].votes > 0 ? s.candidates[0].votes : null;
          return `<div class="result-slot">
            ${s.group_label ? `<div class="group-label">${esc(s.group_label)}</div>` : ''}
            ${s.runoff_pending ? '<div class="banner warn">Tie-break in progress. These scores are not final.</div>' : ''}
            ${s.candidates.length ? s.candidates.map((c) => {
              const win = top !== null && c.votes === top;
              return `<div class="result-row${win ? ' winner' : ''}">
                <span class="result-name">${esc(c.name)}</span>
                <div class="result-bar-wrap"><div class="result-bar" style="width:${Math.round((c.votes / max) * 100)}%"></div></div>
                <span class="result-count">${c.votes} ${win ? '🏆' : '🚲'}</span></div>`;
            }).join('') : '<p class="muted small">No candidates.</p>'}
          </div>`;
        }).join('')}
      </div>`).join('');
  };

  // ── Staff pages ──
  // Returns the user, or redirects to /login. `role` optionally restricts the page.
  window.requireStaff = function (role) {
    const user = Session.user();
    if (!Session.token() || !user) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname);
      return null;
    }
    if (role && user.role !== role) {
      location.href = user.role === 'super_admin' ? '/super' : '/dashboard';
      return null;
    }
    return user;
  };

  window.staffBar = function (user) {
    const bar = el('div', 'staff-bar');
    bar.innerHTML = `
      <a class="staff-brand" href="${user.role === 'super_admin' ? '/super' : '/dashboard'}">◆ Elections</a>
      <div class="row">
        <span class="who"><b>${esc(user.name)}</b> · ${user.role === 'super_admin' ? 'Super admin' : 'Facilitator'}</span>
        <button class="btn sm" id="pwBtn" type="button">Change password</button>
        <button class="btn sm" id="logoutBtn" type="button">Log out</button>
      </div>`;
    document.body.prepend(bar);
    $('#logoutBtn', bar).addEventListener('click', () => { Session.clear(); location.href = '/login'; });
    $('#pwBtn', bar).addEventListener('click', changePasswordDialog);
  };

  function changePasswordDialog() {
    const body = el('div', '', `
      <label class="field">Current password<input type="password" id="cpCur" autocomplete="current-password"/></label>
      <label class="field">New password (8+ characters)<input type="password" id="cpNew" autocomplete="new-password"/></label>`);
    modal({
      title: 'Change password',
      content: body,
      actions: [
        { label: 'Cancel', value: false },
        {
          label: 'Save', kind: 'primary', value: true,
          run: async (b) => {
            await api('/auth/change-password', {
              method: 'POST', auth: true,
              body: { current_password: $('#cpCur', b).value, new_password: $('#cpNew', b).value },
            });
            toast('Password updated.');
          },
        },
      ],
    });
  }
})();
