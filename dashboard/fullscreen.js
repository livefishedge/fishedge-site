/* FishEdge shared fullscreen controller for Dashboard and Planner. */
(function (global) {
  'use strict';
  function fallbackClass() { return document.getElementById('bv-map') ? 'fishedge-planner-fullscreen' : 'fishedge-app-fullscreen'; }
  function active() { return Boolean(document.fullscreenElement || document.webkitFullscreenElement || document.webkitIsFullScreen || document.body.classList.contains('fishedge-app-fullscreen') || document.body.classList.contains('fishedge-planner-fullscreen')); }
  function notify() { global.dispatchEvent(new Event('fishedge-fullscreen-change')); }
  async function toggle() {
    const className = fallbackClass();
    if (active()) {
      try { if (document.exitFullscreen) await document.exitFullscreen(); else document.webkitExitFullscreen?.(); } catch (_) {}
      document.body.classList.remove('fishedge-app-fullscreen', 'fishedge-planner-fullscreen');
      notify();
      return false;
    }
    const request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
    if (request) {
      try {
        await request.call(document.documentElement);
        if (active()) { notify(); return true; }
      } catch (_) {}
    }
    document.body.classList.add(className);
    notify();
    return true;
  }
  global.FishEdgeFullscreen = { active, toggle };
  document.addEventListener('fullscreenchange', notify);
  document.addEventListener('webkitfullscreenchange', notify);
})(window);
