/* FishEdge shared fullscreen controller for Dashboard and Planner. */
(function (global) {
  'use strict';
  let transition = null;
  function fallbackClass() { return document.getElementById('bv-map') ? 'fishedge-planner-fullscreen' : 'fishedge-app-fullscreen'; }
  function active() { return Boolean(document.fullscreenElement || document.webkitFullscreenElement || document.webkitIsFullScreen || document.body.classList.contains('fishedge-app-fullscreen') || document.body.classList.contains('fishedge-planner-fullscreen')); }
  function notify() {
    const native = Boolean(document.fullscreenElement || document.webkitFullscreenElement || document.webkitIsFullScreen);
    document.documentElement.classList.toggle('fishedge-native-fullscreen', native);
    global.dispatchEvent(new Event('fishedge-fullscreen-change'));
  }
  function waitForNativeState(expected) {
    return new Promise(resolve => {
      const deadline = Date.now() + 900;
      const check = () => {
        const isNative = Boolean(document.fullscreenElement || document.webkitFullscreenElement || document.webkitIsFullScreen);
        if (isNative === expected || Date.now() >= deadline) return resolve(isNative === expected);
        requestAnimationFrame(check);
      };
      check();
    });
  }
  function bounded(promise, ms) {
    return Promise.race([Promise.resolve(promise), new Promise(resolve => setTimeout(resolve, ms, 'timeout'))]);
  }
  async function toggle() {
    if (transition) return transition;
    transition = (async () => {
    const className = fallbackClass();
    if (active()) {
      try { await bounded(document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen?.(), 900); } catch (_) {}
      document.body.classList.remove('fishedge-app-fullscreen', 'fishedge-planner-fullscreen');
      notify();
      await waitForNativeState(false);
      notify();
      return false;
    }
    const request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
    if (request) {
      try {
        await bounded(request.call(document.documentElement), 900);
        if (await waitForNativeState(true)) { notify(); return true; }
      } catch (_) {}
    }
    document.body.classList.add(className);
    notify();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    notify();
    return true;
    })();
    try { return await transition; } finally { transition = null; }
  }
  global.FishEdgeFullscreen = { active, toggle, transitioning: () => Boolean(transition) };
  document.addEventListener('fullscreenchange', notify);
  document.addEventListener('webkitfullscreenchange', notify);
})(window);
