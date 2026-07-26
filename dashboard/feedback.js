/* FishEdge dashboard feedback widget — shared by every dashboard page.
 * Self-contained: injects markup, CSS, and wires up click + submit.
 * Idempotent (calling it twice is harmless — bail if #feedback-float exists).
 * Panel pops UP (above button), not DOWN. Works on every dashboard page
 * regardless of viewport position because both button and panel are flex
 * children of a column-reverse flex container.
 *
 * Usage: <script src="feedback.js"></script> at end of body.
 */
(function () {
  'use strict';
  if (document.getElementById('feedback-float')) return;   // already injected

  // ---------- Style ----------
  var css = [
    '#feedback-float{',
    '  position:fixed;',
    '  bottom:24px;',
    '  right:24px;',
    '  z-index:1300;',
    '  display:flex;',
    '  flex-direction:column-reverse;',   /* panel above button — pops UP */
    '  align-items:flex-end;',
    '  gap:6px;',
    '  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;',
    '}',
    '#feedback-toggle{',
    '  background:#2d7d46; color:#fff; border:none; border-radius:50%;',
    '  width:48px; height:48px;',
    '  box-shadow:0 2px 12px rgba(0,0,0,.5);',
    '  display:flex; align-items:center; justify-content:center;',
    '  cursor:pointer; flex:0 0 auto; position:relative;',
    '}',
    '#feedback-toggle:hover{ background:#3a9d5c; }',
    '#feedback-toggle::before{',
    '  content:""; width:18px; height:14px;',
    '  border:2px solid currentColor; border-radius:4px; box-sizing:border-box;',
    '  display:block;',
    '}',
    '#feedback-toggle::after{',
    '  content:""; position:absolute;',
    '  width:7px; height:7px;',
    '  border-right:2px solid currentColor;',
    '  border-bottom:2px solid currentColor;',
    '  transform:rotate(45deg);',
    '  margin-top:13px; margin-left:-8px;',
    '  background:#2d7d46;',
    '}',
    '#feedback-panel{',
    '  background:rgba(5,11,16,0.97);',
    '  border:1px solid #1b2836;',
    '  border-radius:12px;',
    '  padding:12px;',
    '  display:flex; gap:8px;',
    '  box-shadow:0 4px 20px rgba(0,0,0,.4);',
    '}',
    '#feedbackInput{',
    '  background:#fff; color:#000; border:none; border-radius:6px;',
    '  padding:8px 10px; width:240px; font-size:14px; outline:none;',
    '  font-family:inherit;',
    '}',
    '#feedbackSubmit{',
    '  background:#2d7d46; color:#fff; border:none; border-radius:6px;',
    '  padding:8px 14px; font-size:14px; font-weight:700;',
    '  cursor:pointer;',
    '}',
    '#feedbackSubmit:hover{ background:#3a9d5c; }',
    '@media (max-width:720px){',
    '  #feedback-float{',
    '    bottom: calc(12px + env(safe-area-inset-bottom, 0px));',
    '    right: 12px;',
    '  }',
    '}',
  ].join('\n');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- Markup ----------
  var host = document.createElement('div');
  host.id = 'feedback-float';
  host.innerHTML = [
    '<button id="feedback-toggle" title="Send feedback" aria-label="Send feedback"></button>',
    '<div id="feedback-panel" style="display:none;">',
    '  <input type="text" id="feedbackInput" placeholder="Questions / comments..." />',
    '  <button id="feedbackSubmit">Send</button>',
    '</div>',
  ].join('\n');
  document.body.appendChild(host);

  // ---------- Behaviour ----------
  var toggle = document.getElementById('feedback-toggle');
  var panel  = document.getElementById('feedback-panel');
  var input  = document.getElementById('feedbackInput');
  var submit = document.getElementById('feedbackSubmit');

  toggle.addEventListener('click', function () {
    var open = panel.style.display === 'flex';
    panel.style.display = open ? 'none' : 'flex';
    if (!open) {
      // Defer focus so the input is interactive as soon as the panel shows
      setTimeout(function(){ try { input.focus(); } catch(_){} }, 0);
    }
  });

  function send() {
    var text = (input.value || '').trim();
    if (!text) return;
    var user = (function () {
      try { return localStorage.getItem('ocean_viewer_last_user') || 'Anonymous'; }
      catch (_) { return 'Anonymous'; }
    })();
    var region = (typeof REGION_ID !== 'undefined' && REGION_ID) ? REGION_ID : 'unknown';
    var page   = window.location.pathname || 'unknown';
    var WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbwQoQQ_bK0AW8796hC92EYjLeX1eQtHW0_rbuFTdaFdY6fQUYOdWdZGst04RpckcFmz_A/exec';
    var payload = { name: user, region: region, page: page, message: text, link: window.location.href };
    // no-cors: Google Apps Script ignores CORS preflight; browser sends simple request.
    fetch(WEBHOOK_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    .then(function () {
      input.value = '';
      alert('Feedback sent!');
    })
    .catch(function () {
      input.value = '';
      alert('Feedback sent!');
    });
  }
  submit.addEventListener('click', send);
  input.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') send();
  });
})();
