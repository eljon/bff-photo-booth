const $ = (id) => document.getElementById(id);
let mode = 'signup'; // or 'signin'
let providers = {}; // which social logins are configured

// Show an error passed back from a failed social sign-in redirect (/?error=…).
const errParam = new URLSearchParams(location.search).get('error');
if (errParam) { history.replaceState({}, '', '/'); }

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
    providers = me.providers || {};
    markProviders();
  } catch { /* offline — show the form */ }
  if (errParam) $('err').textContent = errParam;
})();

function markProviders() {
  for (const btn of document.querySelectorAll('.social')) {
    if (!providers[btn.dataset.provider]) btn.querySelector('.soon').classList.remove('hidden');
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
  btn.addEventListener('click', () => {
    const provider = btn.dataset.provider;
    if (providers[provider]) { location.href = `/api/auth/oauth/${provider}`; return; } // real redirect flow
    $('err').textContent = `${provider[0].toUpperCase() + provider.slice(1)} sign-in isn't set up yet - use email for now.`;
  });
}
