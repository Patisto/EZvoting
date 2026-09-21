(function () {
  const params = new URLSearchParams(location.search);
  const existing = Session.user();
  if (Session.token() && existing) { go(existing); return; }

  function go(user) {
    const next = params.get('next');
    // only same-site paths, and only ones this role can use
    const safe = next && /^\/[^/\\]/.test(next) ? next : null;
    if (safe && user.role === 'super_admin' && safe !== '/dashboard') location.href = safe;
    else if (safe && user.role !== 'super_admin' && (safe === '/dashboard' || safe.startsWith('/manage/'))) location.href = safe;
    else location.href = user.role === 'super_admin' ? '/super' : '/dashboard';
  }

  const btn = $('#loginBtn');
  async function submit() {
    $('#err').textContent = '';
    btn.disabled = true;
    try {
      const { token, user } = await api('/auth/login', {
        method: 'POST',
        body: { username: $('#username').value, password: $('#password').value },
      });
      Session.set(token, user);
      go(user);
    } catch (e) {
      $('#err').textContent = e.message;
      btn.disabled = false;
    }
  }
  btn.addEventListener('click', submit);
  $('#password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  $('#username').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#password').focus(); });
})();
