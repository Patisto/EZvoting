(async function () {
  const user = requireStaff('super_admin');
  if (!user) return;
  staffBar(user);

  const view = $('#view');
  let tab = 'elections';
  let elections = [];
  let facilitators = [];

  async function load() {
    const [e, f] = await Promise.all([
      api('/super/elections', { auth: true }),
      api('/super/facilitators', { auth: true }),
    ]);
    elections = e.elections;
    facilitators = f.facilitators;
    render();
  }

  $$('.tab').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
    render();
  }));

  function render() { (tab === 'elections' ? renderElections : renderFacilitators)(); }

  const checkList = (items, checkedIds, name, labelFn) => items.length
    ? items.map((i) => `<label class="check"><input type="checkbox" name="${name}" value="${i.id}" ${checkedIds.includes(i.id) ? 'checked' : ''}/> ${labelFn(i)}</label>`).join('')
    : '';
  const checked = (root, name) => $$(`input[name="${name}"]:checked`, root).map((i) => Number(i.value));

  // ── Elections ──
  function renderElections() {
    const active = facilitators.filter((f) => f.is_active);
    view.innerHTML = `
      <div class="card">
        <h3>Create an election</h3>
        <p class="muted">Give it a name and choose who will run it. Facilitators set up positions, candidates and open/close each phase.</p>
        <label class="field">Election name<input type="text" id="elName" maxlength="120" placeholder="e.g. SAS Awards 2026"/></label>
        <label class="field">Description (optional)<textarea id="elDesc" maxlength="500"></textarea></label>
        <div class="field">Facilitators
          ${active.length ? checkList(active, [], 'newFac', (f) => `${esc(f.name)} <span class="muted">@${esc(f.username)}</span>`)
            : '<p class="muted small">No facilitators yet. Create some in the Facilitators tab (you can also assign them later).</p>'}
        </div>
        <button class="btn primary" id="createEl" type="button">Create election</button>
      </div>
      <p class="section-label">Elections (${elections.length})</p>
      ${elections.length ? elections.map((e) => `
        <div class="card" data-id="${e.id}">
          <div class="row between">
            <h3>${esc(e.name)}</h3>${phaseChip(e.phase)}
          </div>
          ${e.description ? `<p class="muted">${esc(e.description)}</p>` : ''}
          <p class="small muted" style="margin:6px 0 12px">
            Facilitators: ${e.facilitators.length ? e.facilitators.map((f) => esc(f.name)).join(', ') : '<i>none assigned</i>'}
          </p>
          <div class="item-actions">
            <a class="btn sm primary" href="/manage/${e.id}">Open console</a>
            <button class="btn sm" data-act="facs" type="button">Facilitators</button>
            <button class="btn sm" data-act="edit" type="button">Rename</button>
            <button class="btn sm" data-act="link" type="button">Copy public link</button>
            <button class="btn sm danger-ghost" data-act="del" type="button">Delete</button>
          </div>
        </div>`).join('') : '<div class="banner">No elections yet. Create your first one above.</div>'}`;

    $('#createEl').addEventListener('click', async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true;
      try {
        await api('/super/elections', {
          method: 'POST', auth: true,
          body: { name: $('#elName').value, description: $('#elDesc').value, facilitator_ids: checked(view, 'newFac') },
        });
        toast('Election created.');
        await load();
      } catch (e) { toast(e.message, 'error'); b.disabled = false; }
    });

    view.onclick = async (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const e = elections.find((x) => x.id === Number(btn.closest('.card').dataset.id));
      if (btn.dataset.act === 'link') return copyText(`${location.origin}/e/${e.slug}`);
      if (btn.dataset.act === 'edit') return editElection(e);
      if (btn.dataset.act === 'facs') return assignFacilitators(e);
      if (btn.dataset.act === 'del') return deleteElection(e);
    };
  }

  async function editElection(e) {
    const body = el('div', '', `
      <label class="field">Name<input type="text" id="mName" maxlength="120" value="${esc(e.name)}"/></label>
      <label class="field">Description<textarea id="mDesc" maxlength="500">${esc(e.description || '')}</textarea></label>`);
    const ok = await modal({
      title: 'Rename election', content: body,
      actions: [{ label: 'Cancel', value: false }, {
        label: 'Save', kind: 'primary', value: true,
        run: (b) => api(`/super/elections/${e.id}`, { method: 'PATCH', auth: true, body: { name: $('#mName', b).value, description: $('#mDesc', b).value } }),
      }],
    });
    if (ok) { toast('Saved.'); load(); }
  }

  async function assignFacilitators(e) {
    const active = facilitators.filter((f) => f.is_active || e.facilitators.some((x) => x.id === f.id));
    const body = el('div', '', active.length
      ? checkList(active, e.facilitators.map((f) => f.id), 'asg', (f) => `${esc(f.name)} <span class="muted">@${esc(f.username)}</span>${f.is_active ? '' : ' <span class="chip closed">disabled</span>'}`)
      : '<p class="muted">No facilitators exist yet. Create one in the Facilitators tab first.</p>');
    const ok = await modal({
      title: `Facilitators for ${e.name}`, content: body,
      actions: [{ label: 'Cancel', value: false }, ...(active.length ? [{
        label: 'Save', kind: 'primary', value: true,
        run: (b) => api(`/super/elections/${e.id}/facilitators`, { method: 'PUT', auth: true, body: { facilitator_ids: checked(b, 'asg') } }),
      }] : [])],
    });
    if (ok) { toast('Facilitators updated.'); load(); }
  }

  async function deleteElection(e) {
    const body = el('div', '', `
      <p>This permanently deletes <b>${esc(e.name)}</b> with all its nominations, candidates and votes. This cannot be undone.</p>
      <label class="field" style="margin-top:10px">Type the election name to confirm<input type="text" id="mConfirm" autocomplete="off"/></label>`);
    const ok = await modal({
      title: 'Delete election?', content: body,
      actions: [{ label: 'Cancel', value: false }, {
        label: 'Delete forever', kind: 'danger', value: true,
        run: (b) => api(`/super/elections/${e.id}`, { method: 'DELETE', auth: true, body: { confirm_name: $('#mConfirm', b).value.trim() } }),
      }],
    });
    if (ok) { toast('Election deleted.'); load(); }
  }

  // ── Facilitators ──
  function renderFacilitators() {
    view.innerHTML = `
      <div class="card">
        <h3>Create a facilitator account</h3>
        <p class="muted">Facilitators log in with these details. You will see the password once, so share it with them straight away.</p>
        <div class="grid-2">
          <label class="field">Full name<input type="text" id="fName" maxlength="80"/></label>
          <label class="field">Username<input type="text" id="fUser" maxlength="32" autocapitalize="none" placeholder="e.g. grace.phiri"/></label>
        </div>
        <label class="field">Password (8+ characters)
          <div class="row" style="flex-wrap:nowrap"><input type="text" id="fPass" autocomplete="off"/><button class="btn" id="genPw" type="button" style="margin-top:4px;white-space:nowrap">Generate</button></div>
        </label>
        <div class="field">Assign to elections (optional)
          ${elections.length ? checkList(elections, [], 'newEl', (e) => esc(e.name)) : '<p class="muted small">No elections yet.</p>'}
        </div>
        <button class="btn primary" id="createFac" type="button">Create facilitator</button>
      </div>
      <p class="section-label">Facilitators (${facilitators.length})</p>
      <div class="card" ${facilitators.length ? '' : 'hidden'}>
        ${facilitators.map((f) => `
          <div class="item-row" data-id="${f.id}">
            <div class="item-info"><div>
              <div><b>${esc(f.name)}</b> <span class="muted">@${esc(f.username)}</span> ${f.is_active ? '' : '<span class="chip closed">Disabled</span>'}</div>
              <div class="small muted">${f.elections.length ? esc(f.elections.map((e) => e.name).join(', ')) : 'Not assigned to any election'}</div>
            </div></div>
            <div class="item-actions">
              <button class="btn sm" data-act="pw" type="button">Reset password</button>
              <button class="btn sm" data-act="toggle" type="button">${f.is_active ? 'Disable' : 'Enable'}</button>
              <button class="btn sm danger-ghost" data-act="del" type="button">Delete</button>
            </div>
          </div>`).join('')}
      </div>
      ${facilitators.length ? '' : '<div class="banner">No facilitators yet.</div>'}`;

    $('#genPw').addEventListener('click', () => { $('#fPass').value = genPassword(); });
    $('#createFac').addEventListener('click', async (ev) => {
      const b = ev.currentTarget;
      const creds = { username: $('#fUser').value.trim().toLowerCase(), password: $('#fPass').value };
      b.disabled = true;
      try {
        await api('/super/facilitators', {
          method: 'POST', auth: true,
          body: { name: $('#fName').value, ...creds, election_ids: checked(view, 'newEl') },
        });
        await load();
        showCredentials(creds.username, creds.password);
      } catch (e) { toast(e.message, 'error'); b.disabled = false; }
    });

    view.onclick = async (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const f = facilitators.find((x) => x.id === Number(btn.closest('.item-row').dataset.id));
      if (btn.dataset.act === 'pw') return resetPassword(f);
      if (btn.dataset.act === 'toggle') {
        try {
          await api(`/super/facilitators/${f.id}`, { method: 'PATCH', auth: true, body: { is_active: !f.is_active } });
          toast(f.is_active ? 'Account disabled.' : 'Account enabled.');
          load();
        } catch (e) { toast(e.message, 'error'); }
      }
      if (btn.dataset.act === 'del') {
        if (!(await confirmDialog('Delete facilitator?', `Delete <b>${esc(f.name)}</b>'s account? They will lose access immediately.`, { danger: true, confirmLabel: 'Delete' }))) return;
        try { await api(`/super/facilitators/${f.id}`, { method: 'DELETE', auth: true }); toast('Deleted.'); load(); }
        catch (e) { toast(e.message, 'error'); }
      }
    };
  }

  function showCredentials(username, password) {
    modal({
      title: 'Share these login details',
      content: `<p>The password will not be shown again.</p>
        <div class="cred">Username: ${esc(username)}<br/>Password: ${esc(password)}</div>
        <p class="small muted">Login page: ${esc(location.origin)}/login</p>`,
      actions: [
        { label: 'Copy details', run: async () => { await copyText(`Login: ${location.origin}/login\nUsername: ${username}\nPassword: ${password}`); return false; } },
        { label: 'Done', kind: 'primary', value: true },
      ],
    });
  }

  async function resetPassword(f) {
    const body = el('div', '', `
      <label class="field">New password for ${esc(f.name)}
        <div class="row" style="flex-wrap:nowrap"><input type="text" id="mPw" value="${esc(genPassword())}" autocomplete="off"/></div>
      </label>`);
    const ok = await modal({
      title: 'Reset password', content: body,
      actions: [{ label: 'Cancel', value: false }, {
        label: 'Reset', kind: 'primary', value: true,
        run: (b) => api(`/super/facilitators/${f.id}`, { method: 'PATCH', auth: true, body: { password: $('#mPw', b).value } }),
      }],
    });
    // the detached modal body still holds the typed value
    if (ok) showCredentials(f.username, body.querySelector('#mPw').value);
  }

  try { await load(); } catch (e) { view.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; }
})();
