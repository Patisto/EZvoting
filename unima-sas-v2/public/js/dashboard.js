(async function () {
  const user = requireStaff();
  if (!user) return;
  staffBar(user);
  const list = $('#list');
  try {
    const { elections } = await api('/manage/elections', { auth: true });
    if (!elections.length) {
      list.innerHTML = '<div class="banner">You have not been assigned to any election yet. Ask the super admin to add you.</div>';
      return;
    }
    list.innerHTML = elections.map((e) => `
      <a class="election-card" href="/manage/${e.id}">
        <div class="row between"><h3>${esc(e.name)}</h3>${phaseChip(e.phase)}</div>
        ${e.description ? `<p>${esc(e.description)}</p>` : ''}
        <span class="small muted">Nominations: ${esc(e.nominations_state)} · Voting: ${esc(e.voting_state)}</span>
      </a>`).join('');
  } catch (err) {
    list.innerHTML = `<div class="banner warn">${esc(err.message)}</div>`;
  }
})();
