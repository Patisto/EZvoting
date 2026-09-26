(async function () {
  const user = requireStaff();
  if (!user) return;
  staffBar(user);
  $('#backLink').href = user.role === 'super_admin' ? '/super' : '/dashboard';

  const id = location.pathname.split('/').filter(Boolean)[1];
  const base = `/manage/elections/${id}`;
  const view = $('#view');
  let S = null;              // election state from the server
  let tab = 'overview';

  const call = (path, opts = {}) => api(base + path, { auth: true, ...opts });

  async function load() {
    S = await call('');
    $('#title').textContent = S.election.name;
    $('#phase').innerHTML = phaseChip(S.election.phase);
    document.title = S.election.name + ' · Console';
    const nomTab = $('.tab[data-tab="nominations"]');
    nomTab.classList.toggle('locked', !S.election.nominations_enabled);
    if (!S.election.nominations_enabled && tab === 'nominations') { tab = 'overview'; $$('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'overview')); }
    render();
  }

  $$('.tab').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
    render();
  }));

  function render() {
    view.onclick = null;
    ({ overview: renderOverview, setup: renderSetup, voters: renderVoters, nominations: renderNominations, candidates: renderCandidates, results: renderResultsTab }[tab])();
  }

  async function act(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg); await load(); }
    catch (e) { toast(e.message, 'error'); }
  }

  // Slots = position × group (or just positions when there are no groups)
  const slotGroups = () => (S.groups.length ? S.groups : [{ id: null, label: null }]);
  const slotLabel = (p, g) => `${p.title}${g.label ? ' — ' + g.label : ''}`;

  // ── Overview ──
  function renderOverview() {
    const e = S.election;
    const url = `${location.origin}/e/${e.slug}`;
    const n = e.nominations_state, r = e.registration_state, v = e.voting_state;
    const c = S.counts;

    const emptySlots = [];
    S.positions.forEach((p) => slotGroups().forEach((g) => {
      if (!S.candidates.some((x) => x.position_id === p.id && (x.group_id ?? null) === g.id)) emptySlots.push(slotLabel(p, g));
    }));

    const setup = [];
    if (!S.positions.length) setup.push('Add positions in the <b>Setup</b> tab.');
    if (!S.candidates.length) setup.push('Enter the successful candidates in the <b>Candidates</b> tab.');

    const nomOn = e.nominations_enabled;
    view.innerHTML = `
      <div class="link-box"><span class="small muted">Registration &amp; voting link</span><code>${esc(url)}</code>
        <button class="btn sm" id="copyLink" type="button">Copy</button></div>
      ${setup.length ? `<div class="banner warn"><b>To do:</b><br/>${setup.join('<br/>')}</div>` : ''}
      <div class="stats">
        <div class="stat"><b>${c.voters}</b><span>Registered</span></div>
        <div class="stat"><b>${c.voters_approved}</b><span>Approved</span></div>
        <div class="stat"><b>${c.voters_pending}</b><span>Awaiting approval</span></div>
        <div class="stat"><b>${c.ballots}</b><span>Ballots cast</span></div>
      </div>
      <div class="phase-grid">
        <div class="locked-wrap">
          <div class="phase-card ${nomOn ? '' : 'locked'}"><h4>Nominations</h4>${chip(n)}
            ${n === 'open'
              ? '<button class="btn danger" data-act="nom-close" type="button">Close nominations</button>'
              : `<button class="btn primary" data-act="nom-open" type="button" ${v !== 'pending' || !nomOn ? 'disabled' : ''}>${n === 'closed' ? 'Reopen nominations' : 'Open nominations'}</button>`}
          </div>
          ${nomOn ? '' : '<div class="locked-badge"><span>Off for now</span></div>'}
        </div>
        <div class="phase-card"><h4>1 · Voter registration</h4>${chip(r)}
          ${r === 'open'
            ? '<button class="btn danger" data-act="reg-close" type="button">Close registration</button>'
            : `<button class="btn primary" data-act="reg-open" type="button" ${v !== 'pending' ? 'disabled' : ''}>${r === 'closed' ? 'Reopen registration' : 'Open registration'}</button>`}
        </div>
        <div class="phase-card"><h4>2 · Voting</h4>${chip(v)}
          ${v === 'open'
            ? '<button class="btn danger" data-act="vote-close" type="button">Close voting</button>'
            : `<button class="btn primary" data-act="vote-open" type="button" ${n === 'open' || r === 'open' ? 'disabled' : ''}>${v === 'closed' ? 'Reopen voting' : 'Open voting'}</button>`}
        </div>
        <div class="phase-card"><h4>3 · Results</h4>${chip(e.results_released ? 'results' : 'pending', e.results_released ? 'Released' : 'Hidden')}
          <button class="btn ${e.results_released ? '' : 'success'}" data-act="release" type="button" ${v !== 'closed' ? 'disabled' : ''}>${e.results_released ? 'Hide results' : 'Release results'}</button>
        </div>
      </div>
      <p class="small muted">Flow: open registration → close it → check and approve voters (Voters tab) → open voting → close voting → release results. Only approved voters can vote.</p>`;

    $('#copyLink').addEventListener('click', () => copyText(url));
    view.onclick = async (ev) => {
      const b = ev.target.closest('button[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'nom-open') act(() => call('/nominations/state', { method: 'POST', body: { state: 'open' } }), 'Nominations are open.');
      if (a === 'nom-close') {
        if (await confirmDialog('Close nominations?', 'People will no longer be able to submit nominations.', { danger: true, confirmLabel: 'Close' }))
          act(() => call('/nominations/state', { method: 'POST', body: { state: 'closed' } }), 'Nominations closed.');
      }
      if (a === 'reg-open') act(() => setRegistration('open'), 'Registration is open.');
      if (a === 'reg-close') {
        if (await confirmDialog('Close registration?', 'Nobody new will be able to register. You can then download the list and check it.', { danger: true, confirmLabel: 'Close registration' }))
          act(() => setRegistration('closed'), 'Registration closed.');
      }
      if (a === 'vote-open') {
        const notes = [];
        notes.push(`<b>${c.voters_approved}</b> approved voter${c.voters_approved === 1 ? '' : 's'} will be able to vote.`);
        if (c.voters_pending) notes.push(`<b>${c.voters_pending}</b> registration${c.voters_pending === 1 ? ' is' : 's are'} still awaiting approval and will <b>not</b> be able to vote.`);
        if (emptySlots.length) notes.push(`<b>No candidates yet for:</b><br/>${emptySlots.map(esc).join('<br/>')}`);
        if (await confirmDialog('Open voting?', `${notes.join('<br/><br/>')}<br/><br/>Candidates and positions will be locked once voting is open.`, { confirmLabel: 'Open voting' }))
          act(() => call('/voting/state', { method: 'POST', body: { state: 'open' } }), 'Voting is open.');
      }
      if (a === 'vote-close') {
        if (await confirmDialog('Close voting?', 'Nobody will be able to vote after this.', { danger: true, confirmLabel: 'Close voting' }))
          act(() => call('/voting/state', { method: 'POST', body: { state: 'closed' } }), 'Voting closed.');
      }
      if (a === 'release') {
        const next = !S.election.results_released;
        if (!next || await confirmDialog('Release results?', 'Everyone with the public link will be able to see the results.', { confirmLabel: 'Release' }))
          act(() => call('/results/release', { method: 'POST', body: { released: next } }), next ? 'Results released.' : 'Results hidden.');
      }
    };
  }

  const setRegistration = (state) => call('/registration/state', { method: 'POST', body: { state } });

  // ── Setup ──
  function renderSetup() {
    const e = S.election;
    const groupsLocked = !(e.nominations_state === 'pending' && e.voting_state === 'pending');
    const posLocked = e.voting_state !== 'pending';
    let gDraft = S.groups.map((g) => ({ id: g.id, label: g.label }));
    let pDraft = S.positions.map((p) => ({ id: p.id, label: p.title }));

    view.innerHTML = `
      <div class="card">
        <h3>Positions</h3>
        <p class="muted">The awards or offices people vote for. ${posLocked ? 'Voting has opened, so you can only rename and reorder.' : ''}</p>
        <div id="posList"></div>
        <div class="row">
          <button class="btn sm" id="addPos" type="button" ${posLocked ? 'disabled' : ''}>+ Add position</button>
          <button class="btn primary sm" id="savePos" type="button">Save positions</button>
        </div>
      </div>
      <div class="card">
        <h3>Groups <span class="muted small">(optional)</span></h3>
        <p class="muted">Split every position into separate contests, e.g. <i>Male / Female</i> or <i>Year 1 / Year 2</i>. Each group gets its own winner. Leave empty for a single winner per position.
          ${groupsLocked ? '<br/><b>Groups can only be added or removed before nominations open.</b>' : ''}</p>
        <div id="grpList"></div>
        <div class="row">
          <button class="btn sm" id="addGrp" type="button" ${groupsLocked ? 'disabled' : ''}>+ Add group</button>
          <button class="btn primary sm" id="saveGrp" type="button">Save groups</button>
        </div>
      </div>
      ${e.nominations_enabled ? `<div class="card">
        <h3>Nomination visibility</h3>
        <label class="check"><input type="checkbox" id="pubNoms" ${e.public_nominations ? 'checked' : ''}/> Let the public see the names that have been nominated so far</label>
      </div>` : `<div class="locked-wrap"><div class="card locked">
        <h3>Nomination visibility</h3>
        <label class="check"><input type="checkbox" disabled/> Let the public see the names that have been nominated so far</label>
      </div><div class="locked-badge"><span>Off for now</span></div></div>`}`;

    function drawList(container, draft, { locked, placeholder, movable }) {
      container.innerHTML = draft.map((it, i) => `
        <div class="list-row" data-i="${i}">
          <input type="text" maxlength="80" value="${esc(it.label)}" placeholder="${esc(placeholder)}"/>
          ${movable ? `<button class="btn sm" data-mv="-1" type="button" ${i === 0 ? 'disabled' : ''}>↑</button>
                       <button class="btn sm" data-mv="1" type="button" ${i === draft.length - 1 ? 'disabled' : ''}>↓</button>` : ''}
          <button class="btn sm danger-ghost" data-rm type="button" ${locked ? 'disabled' : ''}>✕</button>
        </div>`).join('') || '<p class="muted small" style="margin-bottom:10px">Nothing added yet.</p>';
      container.oninput = (ev) => {
        const row = ev.target.closest('.list-row');
        if (row) draft[Number(row.dataset.i)].label = ev.target.value;
      };
      container.onclick = (ev) => {
        const row = ev.target.closest('.list-row');
        if (!row) return;
        const i = Number(row.dataset.i);
        if (ev.target.closest('[data-rm]')) draft.splice(i, 1);
        else if (ev.target.closest('[data-mv]')) {
          const j = i + Number(ev.target.closest('[data-mv]').dataset.mv);
          [draft[i], draft[j]] = [draft[j], draft[i]];
        } else return;
        drawList(container, draft, { locked, placeholder, movable });
      };
    }

    const posBox = $('#posList'), grpBox = $('#grpList');
    drawList(posBox, pDraft, { locked: posLocked, placeholder: 'e.g. Most Dedicated', movable: true });
    drawList(grpBox, gDraft, { locked: groupsLocked, placeholder: 'e.g. Male', movable: true });

    $('#addPos').addEventListener('click', () => { pDraft.push({ id: null, label: '' }); drawList(posBox, pDraft, { locked: posLocked, placeholder: 'e.g. Most Dedicated', movable: true }); });
    $('#addGrp').addEventListener('click', () => { gDraft.push({ id: null, label: '' }); drawList(grpBox, gDraft, { locked: groupsLocked, placeholder: 'e.g. Male', movable: true }); });

    async function confirmRemovals(draft, existing, what) {
      const gone = existing.filter((x) => !draft.some((d) => d.id === x.id));
      if (!gone.length) return true;
      return confirmDialog(`Remove ${what}?`, `Removing <b>${gone.map((g) => esc(g.label ?? g.title)).join(', ')}</b> also deletes its nominations and candidates.`, { danger: true, confirmLabel: 'Remove' });
    }

    $('#savePos').addEventListener('click', async () => {
      if (!(await confirmRemovals(pDraft, S.positions, 'positions'))) return;
      act(() => call('/positions', { method: 'PUT', body: { positions: pDraft.map((d) => ({ id: d.id, title: d.label })) } }), 'Positions saved.');
    });
    $('#saveGrp').addEventListener('click', async () => {
      if (!(await confirmRemovals(gDraft, S.groups, 'groups'))) return;
      act(() => call('/groups', { method: 'PUT', body: { groups: gDraft.map((d) => ({ id: d.id, label: d.label })) } }), 'Groups saved.');
    });
    const pubNoms = $('#pubNoms');
    if (pubNoms) pubNoms.addEventListener('change', (ev) =>
      act(() => call('/settings', { method: 'PATCH', body: { public_nominations: ev.target.checked } }), 'Saved.'));
  }

  // ── Voters ──
  let vFilter = { q: '', status: 'all' };

  async function renderVoters() {
    view.innerHTML = '<p class="muted">Loading…</p>';
    let voters;
    try { ({ voters } = await call('/voters')); } catch (e) { view.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; return; }

    const e = S.election;
    const locked = e.voting_state === 'closed';
    const regOpen = e.registration_state === 'open';
    const n = { all: voters.length, pending: 0, approved: 0, rejected: 0 };
    voters.forEach((v) => { n[v.status]++; });
    const statusChip = (s) => `<span class="chip ${{ approved: 'open', rejected: 'closed', pending: 'pending' }[s]}">${{ approved: 'Approved', rejected: 'Rejected', pending: 'Pending' }[s]}</span>`;
    const CAP = 200;

    view.innerHTML = `
      <div class="card">
        <div class="row between">
          <div><h3>Voter registration ${chip(e.registration_state)}</h3>
            <p class="muted" style="margin:0">Students register with their reg number and a password. Close registration, download the list, check it, then approve. Only approved voters can vote.</p></div>
          ${regOpen ? '<button class="btn danger sm" id="regClose" type="button">Close registration</button>'
            : `<button class="btn primary sm" id="regOpen" type="button" ${e.voting_state !== 'pending' ? 'disabled' : ''}>${e.registration_state === 'closed' ? 'Reopen registration' : 'Open registration'}</button>`}
        </div>
      </div>
      <div class="stats">
        <div class="stat"><b>${n.all}</b><span>Registered</span></div>
        <div class="stat"><b>${n.pending}</b><span>Pending</span></div>
        <div class="stat"><b>${n.approved}</b><span>Approved</span></div>
        <div class="stat"><b>${n.rejected}</b><span>Rejected</span></div>
      </div>
      ${locked ? '<div class="banner warn">Voting has closed, so the voter list is locked.</div>' : ''}
      <div class="card">
        <div class="toolbar">
          <input type="text" id="vQ" placeholder="Search reg number…" value="${esc(vFilter.q)}"/>
          <select id="vStatus">
            ${[['all', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']].map(([k, l]) => `<option value="${k}" ${vFilter.status === k ? 'selected' : ''}>${l} (${n[k]})</option>`).join('')}
          </select>
          <span class="grow"></span>
          <button class="btn sm" id="vRefresh" type="button">Refresh</button>
          <button class="btn sm" id="vPdf" type="button">Download PDF</button>
          <button class="btn sm" id="vCsv" type="button" ${n.all ? '' : 'disabled'}>Download list (CSV)</button>
        </div>
        <div class="toolbar">
          <button class="btn success sm" id="vApproveAll" type="button" ${locked || !n.pending ? 'disabled' : ''}>Approve all pending (${n.pending})</button>
          <button class="btn sm" id="vApproveList" type="button" ${locked ? 'disabled' : ''}>Approve from list…</button>
          <button class="btn sm danger-ghost" id="vRejectList" type="button" ${locked ? 'disabled' : ''}>Reject from list…</button>
        </div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Reg number</th><th>Status</th><th>Voted</th><th>Registered</th><th></th></tr></thead><tbody id="vBody"></tbody></table></div>
        <p class="small muted" id="vNote" style="margin-top:8px"></p>
      </div>`;

    function drawRows() {
      const q = normReg(vFilter.q);
      const rows = voters.filter((v) => (vFilter.status === 'all' || v.status === vFilter.status) && (!q || v.reg_number.includes(q)));
      $('#vBody').innerHTML = rows.slice(0, CAP).map((v) => `
        <tr data-id="${v.id}">
          <td class="mono">${esc(v.reg_number)}</td>
          <td>${statusChip(v.status)}</td>
          <td>${v.has_voted ? '✓' : ''}</td>
          <td class="small muted">${esc(new Date(v.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</td>
          <td><div class="item-actions">
            ${v.status !== 'approved' ? `<button class="btn sm" data-a="approved" type="button" ${locked ? 'disabled' : ''}>Approve</button>` : ''}
            ${v.status !== 'rejected' ? `<button class="btn sm danger-ghost" data-a="rejected" type="button" ${locked || v.has_voted ? 'disabled' : ''}>Reject</button>` : ''}
            <button class="btn sm" data-a="reset" type="button" ${locked ? 'disabled' : ''}>Reset password</button>
          </div></td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">No voters match.</td></tr>';
      $('#vNote').textContent = rows.length > CAP ? `Showing the first ${CAP} of ${rows.length}. Use search, or download the CSV for everyone.` : `${rows.length} shown.`;
    }
    drawRows();

    $('#vQ').addEventListener('input', (ev) => { vFilter.q = ev.target.value; drawRows(); });
    $('#vStatus').addEventListener('change', (ev) => { vFilter.status = ev.target.value; drawRows(); });
    $('#vRefresh').addEventListener('click', () => load());
    const rc = $('#regClose'), ro = $('#regOpen');
    if (rc) rc.addEventListener('click', async () => {
      if (await confirmDialog('Close registration?', 'Nobody new will be able to register.', { danger: true, confirmLabel: 'Close registration' }))
        act(() => setRegistration('closed'), 'Registration closed.');
    });
    if (ro) ro.addEventListener('click', () => act(() => setRegistration('open'), 'Registration is open.'));

    $('#vCsv').addEventListener('click', () => {
      const rows = voters.filter((v) => vFilter.status === 'all' || v.status === vFilter.status);
      downloadCSV(
        [['reg_number', 'status', 'has_voted', 'registered_at'], ...rows.map((v) => [v.reg_number, v.status, v.has_voted ? 'yes' : 'no', v.created_at])],
        `${e.slug}-voters-${vFilter.status}-${new Date().toISOString().slice(0, 10)}.csv`);
    });
    $('#vPdf').addEventListener('click', async () => {
      try { await downloadPdf(`/manage/elections/${id}/voters/pdf`, `${e.slug}-voters.pdf`); toast('PDF downloaded.'); }
      catch (err) { toast(err.message, 'error'); }
    });

    $('#vApproveAll').addEventListener('click', async () => {
      if (!(await confirmDialog('Approve all pending?', `This approves <b>${n.pending}</b> registration${n.pending === 1 ? '' : 's'}. Reject any invalid ones first if you have a list.`, { confirmLabel: 'Approve all' }))) return;
      act(() => call('/voters/bulk', { method: 'POST', body: { action: 'approve', scope: 'all_pending' } }), 'Approved.');
    });
    $('#vApproveList').addEventListener('click', () => bulkList('approve'));
    $('#vRejectList').addEventListener('click', () => bulkList('reject'));

    async function bulkList(action) {
      const body = el('div', '', `<p class="muted" style="margin-bottom:8px">Paste registration numbers, one per line (commas and spaces work too).</p>
        <textarea id="bulkRegs" rows="8" placeholder="BIS/01/22/001&#10;BIS/01/22/002"></textarea>`);
      let result = null;
      const ok = await modal({
        title: action === 'approve' ? 'Approve from list' : 'Reject from list',
        content: body,
        actions: [{ label: 'Cancel', value: false }, {
          label: action === 'approve' ? 'Approve' : 'Reject', kind: action === 'approve' ? 'success' : 'danger', value: true,
          run: async (m) => {
            const reg_numbers = $('#bulkRegs', m).value.split(/[\s,;]+/).filter(Boolean);
            if (!reg_numbers.length) throw new Error('Paste at least one registration number.');
            result = await call('/voters/bulk', { method: 'POST', body: { action, scope: 'list', reg_numbers } });
          },
        }],
      });
      if (!ok || !result) return;
      toast(`${result.updated} ${action === 'approve' ? 'approved' : 'rejected'}.`);
      const notes = [];
      if (result.not_found.length) notes.push(`<b>Not registered (${result.not_found.length}):</b><div class="cred">${result.not_found.map(esc).join('<br/>')}</div>`);
      if (result.skipped_voted.length) notes.push(`<b>Already voted, so not rejected (${result.skipped_voted.length}):</b><div class="cred">${result.skipped_voted.map(esc).join('<br/>')}</div>`);
      if (notes.length) await modal({ title: 'Some numbers were skipped', content: notes.join('') });
      load();
    }

    $('#vBody').addEventListener('click', async (ev) => {
      const b = ev.target.closest('button[data-a]');
      if (!b) return;
      const id = Number(b.closest('tr').dataset.id);
      const v = voters.find((x) => x.id === id);
      if (b.dataset.a === 'reset') {
        if (!(await confirmDialog('Reset password?', `Generate a new password for <b>${esc(v.reg_number)}</b>? The old one stops working.`, { confirmLabel: 'Reset' }))) return;
        try {
          const r = await call(`/voters/${id}/reset-password`, { method: 'POST' });
          await modal({ title: 'New password', content: `<p>Give this to the student. It is shown only once.</p><div class="cred">${esc(r.reg_number)}<br/>${esc(r.password)}</div>`,
            actions: [{ label: 'Copy', value: null, run: () => { copyText(`${r.reg_number} / ${r.password}`); return false; } }, { label: 'Done', kind: 'primary', value: true }] });
        } catch (err) { toast(err.message, 'error'); }
        return;
      }
      act(() => call(`/voters/${id}`, { method: 'PATCH', body: { status: b.dataset.a } }), b.dataset.a === 'approved' ? 'Approved.' : 'Rejected.');
    });
  }
  const normReg = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

  // ── Nominations ──
  async function renderNominations() {
    view.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const { summary } = await call('/nominations');
      const locked = S.election.voting_state !== 'pending';
      const isCand = (p, g, name) => S.candidates.some((c) => c.position_id === p.id && (c.group_id ?? null) === g.id && c.name.toLowerCase() === name.toLowerCase());

      view.innerHTML = `
        <div class="row between" style="margin-bottom:12px">
          <p class="muted">${S.counts.submissions} submissions · ${S.counts.nominations} names. Tap <b>Add as candidate</b> to put a nominee on the ballot.</p>
          <button class="btn sm" id="refresh" type="button">Refresh</button>
        </div>
        ${S.positions.length ? S.positions.map((p) => `
          <div class="card">
            <h3>${esc(p.title)}</h3>
            ${slotGroups().map((g) => {
              const rows = summary.filter((r) => r.position_id === p.id && (r.group_id ?? null) === g.id);
              return `${g.label ? `<div class="group-label">${esc(g.label)}</div>` : ''}
                ${rows.length ? rows.map((r) => `
                  <div class="nominee-pick">
                    <span>${esc(r.name)} <span class="nominee-count">${r.count > 1 ? `(${r.count} nominations)` : ''}</span></span>
                    ${isCand(p, g, r.name) ? '<span class="chip open">On ballot</span>'
                      : `<button class="btn sm" data-add type="button" data-p="${p.id}" data-g="${g.id ?? ''}" data-n="${esc(r.name)}" ${locked ? 'disabled' : ''}>Add as candidate</button>`}
                  </div>`).join('') : '<p class="muted small">No nominations yet.</p>'}`;
            }).join('')}
          </div>`).join('') : '<div class="banner">Add positions in Setup first.</div>'}`;

      $('#refresh').addEventListener('click', () => load());
      view.onclick = (ev) => {
        const b = ev.target.closest('button[data-add]');
        if (!b) return;
        act(() => call('/candidates', { method: 'POST', body: { position_id: Number(b.dataset.p), group_id: b.dataset.g ? Number(b.dataset.g) : null, name: b.dataset.n } }), 'Added to ballot.');
      };
    } catch (e) { view.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; }
  }

  // ── Candidates ──
  function renderCandidates() {
    const locked = S.election.voting_state !== 'pending';
    if (!S.positions.length) { view.innerHTML = '<div class="banner">Add positions in Setup first.</div>'; return; }

    view.innerHTML = `
      ${locked ? '<div class="banner warn">Voting has opened, so candidates are locked. You can still fix names and photos.</div>' : `
      <div class="card">
        <h3>Add a candidate</h3>
        <div class="grid-2">
          <label class="field">Position<select id="cPos">${S.positions.map((p) => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}</select></label>
          ${S.groups.length ? `<label class="field">Group<select id="cGrp">${S.groups.map((g) => `<option value="${g.id}">${esc(g.label)}</option>`).join('')}</select></label>` : '<div></div>'}
        </div>
        <div class="grid-2">
          <label class="field">Name<input type="text" id="cName" placeholder="Jane Banda"/></label>
          <label class="field">Photo link<input type="url" id="cPhoto" placeholder="https://example.com/photo.jpg (optional)"/></label>
        </div>
        <div class="row">
          <button class="btn primary" id="addCand" type="button">Add candidate</button>
        </div>
        <details style="margin-top:12px">
          <summary class="muted small" style="cursor:pointer">Bulk add (paste several names, one per line — photo link after a <b>|</b>)</summary>
          <label class="field" style="margin-top:8px">Candidates — one per line.
            <textarea id="cNames" rows="4" placeholder="Jane Banda&#10;John Phiri | https://example.com/john.jpg"></textarea></label>
          <button class="btn sm" id="addBulk" type="button" style="margin-top:8px">Add from list</button>
        </details>
      </div>`}
      ${S.positions.map((p) => `
        <div class="card"><h3>${esc(p.title)}</h3>
          ${slotGroups().map((g) => {
            const cs = S.candidates.filter((c) => c.position_id === p.id && (c.group_id ?? null) === g.id);
            return `${g.label ? `<div class="group-label">${esc(g.label)}</div>` : ''}
              ${cs.length ? cs.map((c) => `
                <div class="item-row" data-id="${c.id}">
                  <div class="item-info">${c.photo_url ? `<img class="thumb" src="${esc(c.photo_url)}" alt="" data-photo="${esc(c.photo_url)}" data-name="${esc(c.name)}"/>` : `<div class="thumb">${esc(initials(c.name))}</div>`}<span>${esc(c.name)}</span></div>
                  <div class="item-actions">
                    <button class="btn sm" data-act="edit" type="button">Edit</button>
                    <button class="btn sm danger-ghost" data-act="del" type="button" ${locked ? 'disabled' : ''}>Remove</button>
                  </div>
                </div>`).join('') : '<p class="muted small">No candidates yet.</p>'}`;
          }).join('')}
        </div>`).join('')}`;

    const add = $('#addCand');
    if (add) add.addEventListener('click', () => {
      const name = $('#cName').value.trim();
      if (!name) { toast('Enter a candidate name.', 'error'); return; }
      act(async () => {
        await call('/candidates', {
          method: 'POST',
          body: { position_id: Number($('#cPos').value), group_id: $('#cGrp') ? Number($('#cGrp').value) : null, name, photo_url: $('#cPhoto').value.trim() },
        });
      }, 'Candidate added.');
    });

    const addBulk = $('#addBulk');
    if (addBulk) addBulk.addEventListener('click', () => {
      const candidates = $('#cNames').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const i = l.indexOf('|');
        return i === -1 ? { name: l, photo_url: '' } : { name: l.slice(0, i).trim(), photo_url: l.slice(i + 1).trim() };
      });
      if (!candidates.length) { toast('Enter at least one name.', 'error'); return; }
      act(async () => {
        await call('/candidates/bulk', {
          method: 'POST',
          body: { position_id: Number($('#cPos').value), group_id: $('#cGrp') ? Number($('#cGrp').value) : null, candidates },
        });
      }, candidates.length === 1 ? 'Candidate added.' : `${candidates.length} candidates added.`);
    });

    view.onclick = async (ev) => {
      const b = ev.target.closest('button[data-act]');
      if (!b) return;
      const c = S.candidates.find((x) => x.id === Number(b.closest('.item-row').dataset.id));
      if (b.dataset.act === 'del') {
        if (await confirmDialog('Remove candidate?', `Remove <b>${esc(c.name)}</b> from the ballot?`, { danger: true, confirmLabel: 'Remove' }))
          act(() => call(`/candidates/${c.id}`, { method: 'DELETE' }), 'Removed.');
      } else {
        const body = el('div', '', `
          <label class="field">Full name<input type="text" id="eName" maxlength="80" value="${esc(c.name)}"/></label>
          <label class="field">Photo link<input type="url" id="ePhoto" maxlength="500" value="${esc(c.photo_url || '')}"/></label>`);
        const ok = await modal({
          title: 'Edit candidate', content: body,
          actions: [{ label: 'Cancel', value: false }, {
            label: 'Save', kind: 'primary', value: true,
            run: (m) => call(`/candidates/${c.id}`, { method: 'PATCH', body: { name: $('#eName', m).value, photo_url: $('#ePhoto', m).value } }),
          }],
        });
        if (ok) { toast('Saved.'); load(); }
      }
    };
  }

  // ── Results ──
  async function renderResultsTab() {
    view.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const { results } = await call('/results');
      view.innerHTML = `
        <div class="row between" style="margin-bottom:12px">
          <p class="muted"><b>${results.total_ballots}</b> ballots cast of ${S.counts.voters_approved} approved voters${S.election.voting_state === 'open' ? ' · voting is open, counts are live' : ''}</p>
          <div class="item-actions">
            <button class="btn sm" id="refresh" type="button">Refresh</button>
            <button class="btn sm" id="export" type="button">Download data (JSON)</button>
            <button class="btn sm" id="pdf" type="button">Download PDF</button>
          </div>
        </div>
        <div id="resBox"></div>`;
      renderResults($('#resBox'), results);
      $('#refresh').addEventListener('click', renderResultsTab);
      $('#export').addEventListener('click', async () => {
        try { downloadJSON(await call('/export'), `${S.election.slug}-${new Date().toISOString().slice(0, 10)}.json`); }
        catch (e) { toast(e.message, 'error'); }
      });
      $('#pdf').addEventListener('click', async () => {
        try { await downloadPdf(`/manage/elections/${id}/results/pdf`, `${S.election.slug}-results.pdf`); toast('PDF downloaded.'); }
        catch (e) { toast(e.message, 'error'); }
      });
    } catch (e) { view.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; }
  }

  try { await load(); } catch (e) {
    view.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`;
    $('#title').textContent = 'Election';
  }
})();
