(async function () {
  api('/public/config').then((c) => { $('#brand').textContent = c.brand; document.title = c.brand; }).catch(() => {});
  const list = $('#list');
  try {
    const { elections } = await api('/public/elections');
    if (!elections.length) {
      list.innerHTML = '<div class="banner">No elections are running right now. Please check back later.</div>';
      return;
    }
    list.innerHTML = elections.map((e) => `
      <a class="election-card" href="/e/${encodeURIComponent(e.slug)}">
        <div class="row between"><h3>${esc(e.name)}</h3>${phaseChip(e.phase)}</div>
        ${e.description ? `<p>${esc(e.description)}</p>` : ''}
      </a>`).join('');
  } catch (err) {
    list.innerHTML = `<div class="banner warn">${esc(err.message)}</div>`;
  }
})();
