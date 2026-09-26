(async function () {
  const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
  const app = $('#app');
  api('/public/config').then((c) => { $('#brand').textContent = c.brand; }).catch(() => {});

  let data;
  try {
    data = await api('/public/elections/' + encodeURIComponent(slug));
  } catch (e) {
    $('#electionName').textContent = 'Election not found';
    app.innerHTML = `<div class="banner warn">${esc(e.message)}</div><p style="text-align:center"><a class="btn primary" href="/">See all elections</a></p>`;
    return;
  }

  const { election, groups, positions, candidates } = data;
  document.title = election.name;
  $('#electionName').textContent = election.name;
  $('#electionDesc').textContent = election.description || '';

  const SESSION_KEY = `ems_voter_session_${slug}`; // sessionStorage: cleared when the tab closes (safer on shared PCs)
  const slotGroups = groups.length ? groups : [{ id: null, label: null }];

  function setStatus(kind, text) {
    $('#statusBar').classList.remove('hidden');
    $('#statusDot').className = 'dot ' + kind;
    $('#statusText').textContent = text;
  }

  // ── Tabs (nominations phase only) ──
  function setTabs(items, active, onSelect) {
    const nav = $('#tabs');
    nav.classList.remove('hidden');
    nav.innerHTML = items.map((t) => `<button type="button" data-tab="${t.key}" class="${t.key === active ? 'active' : ''}">${esc(t.label)}</button>`).join('');
    nav.onclick = (e) => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      $$('button', nav).forEach((x) => x.classList.toggle('active', x === b));
      onSelect(b.dataset.tab);
    };
  }

  // ── Nominations ──
  function renderNominations() {
    if (election.public_nominations) {
      setTabs([{ key: 'nominate', label: 'Nominate' }, { key: 'see', label: 'See nominations' }], 'nominate', (k) => {
        if (k === 'nominate') showForm(); else renderNominationList(false);
      });
    }
    showForm();
  }

  function showForm() {
    const bar = $('#submitBar');
    bar.classList.remove('hidden');
    const btn = $('#submitBtn');
    btn.textContent = 'Submit my nominations';
    btn.disabled = false;
    btn.onclick = submitNominations;

    app.innerHTML = `
      <div class="counter">Total submissions: <b id="subCount">${data.submission_count}</b></div>
      <p class="muted small" style="margin-bottom:12px">Fill in the names you want to nominate. You can leave any box empty.</p>
      ${positions.map((p, i) => `
        <div class="position-card">
          <div class="position-title"><span class="position-num">${i + 1}</span>${esc(p.title)}</div>
          ${slotGroups.map((g) => `
            <label class="field">${g.label ? esc(g.label) : 'Nominee'}
              <input type="text" maxlength="80" autocomplete="off" placeholder="Full name"
                     data-position="${p.id}" data-group="${g.id ?? ''}"/>
            </label>`).join('')}
        </div>`).join('')}`;
  }

  async function submitNominations() {
    const nominations = $$('input[data-position]').map((i) => ({
      position_id: Number(i.dataset.position),
      group_id: i.dataset.group ? Number(i.dataset.group) : null,
      nominee_name: i.value.trim(),
    })).filter((n) => n.nominee_name);

    if (!nominations.length) { toast('Please fill in at least one name.', 'error'); return; }
    if (nominations.some((n) => n.nominee_name.length < 2)) { toast('Names must be at least 2 characters.', 'error'); return; }

    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Submitting…';
    try {
      const res = await api(`/public/elections/${encodeURIComponent(slug)}/nominations`, { method: 'POST', body: { nominations } });
      $$('input[data-position]').forEach((i) => { i.value = ''; });
      $('#subCount').textContent = res.submission_count;
      toast('Nominations submitted. Thank you!');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Submit my nominations';
    }
  }

  async function renderNominationList(standalone) {
    $('#submitBar').classList.add('hidden');
    if (!standalone) app.innerHTML = '<p class="muted">Loading…</p>';
    const target = standalone ? el('div') : app;
    if (standalone) app.appendChild(target);
    try {
      const { summary } = await api(`/public/elections/${encodeURIComponent(slug)}/nominations`);
      target.innerHTML = `
        <p class="section-label">Names people are nominating</p>
        ${positions.map((p) => `
          <div class="position-card">
            <div class="position-title">${esc(p.title)}</div>
            ${slotGroups.map((g) => {
              const rows = summary.filter((r) => r.position_id === p.id && (r.group_id ?? null) === g.id);
              return `${g.label ? `<div class="group-label">${esc(g.label)}</div>` : ''}
                ${rows.length ? `<ul class="nominee-list">${rows.map((r) =>
                  `<li>${esc(r.name)}${r.count > 1 ? ` <span class="nominee-count">(${r.count})</span>` : ''}</li>`).join('')}</ul>`
                  : '<p class="muted small">No nominations yet.</p>'}`;
            }).join('')}
          </div>`).join('')}`;
    } catch (e) {
      target.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`;
    }
  }

  // ── Voter area: register, log in, vote ──
  const REG_RE = /^[A-Z0-9][A-Z0-9/._-]{2,29}$/;
  const normReg = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();

  const getSession = () => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (_) { return null; } };
  const setSession = (x) => sessionStorage.setItem(SESSION_KEY, JSON.stringify(x));
  const clearSession = () => sessionStorage.removeItem(SESSION_KEY);

  function pwField(id, label, autocomplete) {
    return `<label class="field">${label}
      <div class="pw-wrap"><input type="password" id="${id}" autocomplete="${autocomplete}" maxlength="72"/>
      <button type="button" class="pw-toggle" data-for="${id}">Show</button></div></label>`;
  }

  function wirePwToggles(root) {
    $$('.pw-toggle', root).forEach((b) => b.addEventListener('click', () => {
      const input = $('#' + b.dataset.for, root);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.textContent = show ? 'Hide' : 'Show';
    }));
  }

  // canRegister: registration is open, so show Register / Log in tabs.
  function renderVoterArea(canRegister) {
    $('#submitBar').classList.add('hidden');
    if (canRegister) {
      setTabs([{ key: 'register', label: 'Register' }, { key: 'login', label: 'Log in' }], 'register', (k) => {
        if (k === 'register') renderRegister(); else showLogin();
      });
      renderRegister();
    } else {
      showLogin();
    }
  }

  // Log in (or resume) and show whatever the voter can do right now.
  async function showLogin() {
    $('#submitBar').classList.add('hidden');
    const sess = getSession();
    if (sess) {
      app.innerHTML = '<p class="muted">Loading…</p>';
      try {
        const { voter } = await api(`/public/elections/${encodeURIComponent(slug)}/me`, { token: sess.token });
        renderVoterHome(voter);
        return;
      } catch (_) { clearSession(); }
    }
    renderLogin();
  }

  function renderLogin() {
    const phase = election.phase;
    app.innerHTML = `
      ${phase === 'registration_closed' ? '<div class="banner">Registration has closed. Voting will open soon. Log in to check that your registration was approved.</div>' : ''}
      ${phase === 'registration' ? '<div class="banner">Already registered? Log in to check your status. You can vote once voting opens.</div>' : ''}
      <div class="card auth-card">
        <h3>Log in</h3>
        <p class="muted small" style="margin-bottom:12px">Use the registration number and password you registered with.</p>
        <label class="field">Registration number<input type="text" id="lgReg" autocomplete="username" autocapitalize="characters" maxlength="40"/></label>
        ${pwField('lgPw', 'Password', 'current-password')}
        <button class="btn primary block" id="lgBtn" type="button">Log in</button>
      </div>`;
    wirePwToggles(app);
    const go = async () => {
      const reg = normReg($('#lgReg').value);
      const password = $('#lgPw').value;
      if (!reg || !password) { toast('Enter your registration number and password.', 'error'); return; }
      const btn = $('#lgBtn');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Logging in…';
      try {
        const res = await api(`/public/elections/${encodeURIComponent(slug)}/voter-login`, { method: 'POST', body: { reg_number: reg, password } });
        setSession({ token: res.token, reg: res.voter.reg_number });
        renderVoterHome(res.voter);
      } catch (e) {
        toast(e.message, 'error');
        btn.disabled = false; btn.textContent = 'Log in';
      }
    };
    $('#lgBtn').addEventListener('click', go);
    ['#lgReg', '#lgPw'].forEach((sel) => $(sel).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); }));
  }

  function renderRegister() {
    app.innerHTML = `
      <div class="card auth-card">
        <h3>Register to vote</h3>
        <p class="muted small" style="margin-bottom:12px">Enter your registration number and choose a password. The elections committee will check your registration before voting opens.</p>
        <div class="banner warn"><b>Remember your password.</b> You will need this exact registration number and password to vote. There is no email recovery. If you forget it, you must ask the elections committee.</div>
        <label class="field">Registration number<input type="text" id="rgReg" autocomplete="username" autocapitalize="characters" maxlength="40"/></label>
        ${pwField('rgPw', 'Choose a password (6+ characters)', 'new-password')}
        ${pwField('rgPw2', 'Type the password again', 'new-password')}
        <label class="check"><input type="checkbox" id="rgNoted"/> I have written down my password</label>
        <button class="btn primary block" id="rgBtn" type="button">Register</button>
      </div>`;
    wirePwToggles(app);
    $('#rgBtn').addEventListener('click', async () => {
      const reg = normReg($('#rgReg').value);
      const pw = $('#rgPw').value, pw2 = $('#rgPw2').value;
      if (!REG_RE.test(reg)) { toast('Enter a valid registration number.', 'error'); return; }
      if (pw.length < 6) { toast('Password must be at least 6 characters.', 'error'); return; }
      if (pw !== pw2) { toast('The two passwords do not match.', 'error'); return; }
      if (!$('#rgNoted').checked) { toast('Please tick the box to confirm you have noted your password.', 'error'); return; }

      const btn = $('#rgBtn');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Registering…';
      try {
        const res = await api(`/public/elections/${encodeURIComponent(slug)}/register`, { method: 'POST', body: { reg_number: reg, password: pw } });
        app.innerHTML = `
          <div class="card auth-card center">
            <h3>You are registered ✓</h3>
            <div class="cred">${esc(res.reg_number)}</div>
            <p class="muted" style="margin:8px 0 14px">Keep your password safe. Your registration will be checked by the elections committee. When voting opens, come back to this page and log in.</p>
            <button class="btn primary" id="toLogin" type="button">Go to log in</button>
          </div>`;
        $('#toLogin').addEventListener('click', () => {
          $$('#tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'login'));
          showLogin();
        });
      } catch (e) {
        toast(e.message, 'error');
        btn.disabled = false; btn.textContent = 'Register';
      }
    });
  }

  function voterBar(voter) {
    return `<div class="voter-bar"><span>Logged in as <b>${esc(voter.reg_number)}</b></span><button class="btn sm" id="logoutBtn" type="button">Log out</button></div>`;
  }

  function renderVoterHome(voter) {
    const bar = $('#submitBar');
    bar.classList.add('hidden');
    const phase = election.phase;
    let body;
    if (voter.status === 'rejected') {
      body = '<div class="banner warn">Your registration was not approved, so you cannot vote. Please contact the elections committee.</div>';
    } else if (voter.status === 'pending') {
      body = '<div class="banner warn">Your registration is still waiting for approval by the elections committee. Check again later.</div>';
    } else if (phase === 'runoff' && !voter.runoff_has_voted) {
      app.innerHTML = voterBar(voter) + '<div id="ballotBox"></div>';
      $('#logoutBtn').addEventListener('click', logout);
      renderBallot();
      return;
    } else if (phase === 'voting' && !voter.has_voted) {
      app.innerHTML = voterBar(voter) + '<div id="ballotBox"></div>';
      $('#logoutBtn').addEventListener('click', logout);
      renderBallot();
      return;
    } else if (phase === 'runoff') {
      body = '<div class="banner ok">Your tie-break vote has been recorded. Thank you.</div>';
    } else if (voter.has_voted) {
      body = '<div class="banner ok">You have voted. Thank you for taking part.</div>';
    } else if (phase !== 'voting') {
      body = '<div class="banner ok">Your registration is approved ✓ Voting has not opened yet. Come back to this page and log in when it does.</div>';
    } else {
      app.innerHTML = voterBar(voter) + '<div id="ballotBox"></div>';
      $('#logoutBtn').addEventListener('click', logout);
      renderBallot();
      return;
    }
    app.innerHTML = voterBar(voter) + body;
    $('#logoutBtn').addEventListener('click', logout);
  }

  function logout() {
    clearSession();
    selections.clear();
    $('#submitBar').classList.add('hidden');
    renderLogin();
  }

  const selections = new Map(); // "positionId:groupId" -> candidateId

  function renderBallot() {
    const box = $('#ballotBox');
    const bar = $('#submitBar');
    const btn = $('#submitBtn');
    bar.classList.remove('hidden');
    btn.textContent = 'Submit vote';
    btn.disabled = false;
    btn.onclick = submitVotes;

    const runoff = election.phase === 'runoff';
    const activeSlots = runoff ? election.runoff_slots : [];
    const isActive = (p, g) => !runoff || activeSlots.some((s) => s.position_id === p.id && (s.group_id ?? null) === g.id);
    const ballotPositions = positions.filter((p) => slotGroups.some((g) => isActive(p, g)));
    box.innerHTML = `
      <p class="muted small" style="margin-bottom:12px">${runoff ? 'Tie-break vote: choose one candidate in each tied category.' : 'Choose one candidate per category, then submit. You can only vote once, and you can skip categories.'}</p>
      ${ballotPositions.map((p, i) => `
        <div class="position-block">
          <div class="position-title"><span class="position-num">${i + 1}</span>${esc(p.title)}</div>
          ${slotGroups.filter((g) => isActive(p, g)).map((g) => {
            const active = activeSlots.find((s) => s.position_id === p.id && (s.group_id ?? null) === g.id);
            const cs = candidates.filter((c) => c.position_id === p.id && (c.group_id ?? null) === g.id && (!runoff || active.candidate_ids.includes(c.id)));
            return `${g.label ? `<div class="group-label">${esc(g.label)}</div>` : ''}
              ${cs.length ? `<div class="candidates-grid">${cs.map((c) => `
                <div class="candidate-card" data-pos="${p.id}" data-group="${g.id ?? ''}" data-id="${c.id}">
                  ${avatar(c)}<div class="candidate-name">${esc(c.name)}</div>
                </div>`).join('')}</div>` : '<p class="muted small">No candidates listed.</p>'}`;
          }).join('')}
        </div>`).join('')}`;

    box.onclick = (e) => {
      const card = e.target.closest('.candidate-card');
      if (!card) return;
      const key = `${card.dataset.pos}:${card.dataset.group || 0}`;
      const id = Number(card.dataset.id);
      const siblings = $$(`.candidate-card[data-pos="${card.dataset.pos}"][data-group="${card.dataset.group}"]`, box);
      siblings.forEach((s) => s.classList.remove('selected'));
      if (selections.get(key) === id) { selections.delete(key); return; } // tap again to un-pick
      selections.set(key, id);
      card.classList.add('selected');
    };
  }

  async function submitVotes() {
    if (!selections.size) { toast('Select at least one candidate first.', 'error'); return; }
    const votes = Array.from(selections, ([key, candidate_id]) => {
      const [p, g] = key.split(':').map(Number);
      return { position_id: p, group_id: g || null, candidate_id };
    });
    const totalSlots = election.phase === 'runoff'
      ? election.runoff_slots.length
      : positions.length * slotGroups.length;
    const skipped = totalSlots - votes.length;
    const msg = skipped > 0
      ? `You have skipped ${skipped} categor${skipped === 1 ? 'y' : 'ies'}. You cannot change your vote after submitting.`
      : 'You cannot change your vote after submitting.';
    if (!(await confirmDialog('Submit your vote?', msg, { confirmLabel: 'Submit vote' }))) return;

    const sess = getSession();
    if (!sess) { toast('Your session ended. Please log in again.', 'error'); logout(); return; }

    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Submitting…';
    try {
      await api(`/public/elections/${encodeURIComponent(slug)}/vote`, { method: 'POST', body: { votes }, token: sess.token });
      selections.clear();
      toast('Vote submitted. Thank you!');
      renderVoterHome({ reg_number: sess.reg, status: 'approved', has_voted: true, runoff_has_voted: election.phase === 'runoff' });
    } catch (e) {
      if (e.status === 401) { toast('Your session ended. Please log in again.', 'error'); logout(); return; }
      if (e.status === 409) { toast(e.message, 'error'); showLogin(); return; }
      if (e.status === 403) { toast(e.message, 'error'); setTimeout(() => location.reload(), 1500); return; }
      btn.disabled = false; btn.textContent = 'Submit vote';
      toast(e.message, 'error');
    }
  }

  // ── Results ──
  async function renderPublicResults() {
    $('#submitBar').classList.add('hidden');
    app.innerHTML = '<div class="banner ok">Results have been released.</div><div id="resultsBox"><p class="muted">Loading…</p></div>';
    try {
      const res = await api(`/public/elections/${encodeURIComponent(slug)}/results`);
      if (!res.released) { $('#resultsBox').innerHTML = '<p class="muted">Results are not available.</p>'; return; }
      renderResults($('#resultsBox'), res.results);
      $('#resultsBox').insertAdjacentHTML('afterbegin', `<p class="muted small" style="margin-bottom:10px">Total voters: ${res.results.total_ballots}</p>`);
    } catch (e) {
      $('#resultsBox').innerHTML = `<div class="banner warn">${esc(e.message)}</div>`;
    }
  }

  // ── Start (everything above is defined by now) ──
  switch (election.phase) {
    case 'registration': setStatus('open', 'Voter registration is open'); renderVoterArea(true); break;
    case 'registration_closed':
      setStatus('closed', 'Registration is closed');
      renderVoterArea(false);
      break;
    case 'nominations': setStatus('open', 'Nominations are open'); renderNominations(); break;
    case 'nominations_closed':
      setStatus('closed', 'Nominations are closed');
      app.innerHTML = '<div class="banner">Nominations have closed. Voting will open soon — check back later.</div>';
      if (election.public_nominations) renderNominationList(true);
      break;
    case 'voting': setStatus('open', 'Voting is open'); renderVoterArea(false); break;
    case 'runoff': setStatus('open', 'Tie-break voting is open'); renderVoterArea(false); break;
    case 'voting_closed':
      setStatus('closed', 'Voting is closed');
      app.innerHTML = '<div class="banner">Voting has closed. Results will be announced soon.</div>';
      break;
    case 'results': setStatus('closed', 'Voting closed — results released'); renderPublicResults(); break;
    default: app.innerHTML = '<div class="banner">This election has not started yet.</div>';
  }
})();
