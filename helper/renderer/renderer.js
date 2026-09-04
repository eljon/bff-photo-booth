'use strict';

const $ = (id) => document.getElementById(id);

function render(status) {
  const dot = $('dot');
  const msg = $('msg');
  dot.className = `dot ${status.state || ''}`;
  msg.textContent = status.message || 'Not connected';
  const running = status.state === 'connected' || status.state === 'connecting';
  $('connect').hidden = running;
  $('disconnect').hidden = !running;
}

async function init() {
  const state = await window.helper.getState();
  if (state.config && state.config.relay) $('relay').value = state.config.relay;
  render(state);
}

$('connect').addEventListener('click', () => {
  window.helper.connect({ relay: $('relay').value, code: $('code').value });
});
$('disconnect').addEventListener('click', () => window.helper.disconnect());
window.helper.onStatus(render);

init();
