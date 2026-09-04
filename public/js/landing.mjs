const $ = (id) => document.getElementById(id);
let mode = 'signup'; // or 'signin'

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// If already signed in, go straight to the dashboard.
(async () => {
  try {
    const me = await (await fetch('/api/me')).json();
    if (me.user) { location.href = '/dashboard'; return; }
    markProviders(me.providers || {});
  } catch { /* offline — show the form */ }
})();

function markProviders(providers) {
  for (const btn of document.querySelectorAll('.social')) {
    const p = btn.dataset.provider;
    if (!providers[p]) btn.querySelector('.soon').classList.remove('hidden');
  }
}

function setMode(next) {
  mode = next;
  const signup = mode === 'signup';
  $('authTitle').textContent = signup ? 'Create your account' : 'Welcome back';
  $('authSub').textContent = signup ? 'Start your first booth session.' : 'Sign in to your dashboard.';
  $('submit').textContent = signup ? 'Create account' : 'Sign in';
  $('nameField').classList.toggle('hidden', !signup);
  $('password').autocomplete = signup ? 'new-password' : 'current-password';
  $('toggle').innerHTML = signup
    ? 'Already have an account? <button type="button" id="toggleBtn">Sign in</button>'
    : "New here? <button type=\"button\" id=\"toggleBtn\">Create an account</button>";
  $('toggleBtn').addEventListener('click', () => setMode(signup ? 'signin' : 'signup'));
  $('err').textContent = '';
}

$('toggleBtn').addEventListener('click', () => setMode('signin'));
$('navSignin').addEventListener('click', (e) => { e.preventDefault(); setMode('signin'); $('email').focus(); });

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('err').textContent = '';
  $('submit').disabled = true;
  const body = { email: $('email').value.trim(), password: $('password').value, name: $('name').value.trim() };
  const path = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
  const { status, data } = await api(path, body);
  $('submit').disabled = false;
  if (status === 200 && data.ok) { location.href = '/dashboard'; return; }
  $('err').textContent = data.error || 'Something went wrong. Try again.';
});

for (const btn of document.querySelectorAll('.social')) {
  btn.addEventListener('click', async () => {
    const provider = btn.dataset.provider;
    const res = await fetch(`/api/auth/oauth/${provider}`);
    const data = await res.json().catch(() => ({}));
    if (res.status === 200 && data.redirect) { location.href = data.redirect; return; }
    $('err').textContent = data.error || `${provider} sign-in isn't available yet — use email for now.`;
  });
}
