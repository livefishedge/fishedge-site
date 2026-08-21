/* Planner SPA router — fishedge dev site only (branch feat/briefing-raster-v2)
   When location.pathname === '/planner' (or '/planner/'), fetch
   /dashboard/planner/viewer.html and replace the document with its content.
   This lets /planner and /dashboard both serve real pages from the SAME
   dashboard/index.html file (no HTTP redirect — Cloudflare Pages 200 rewrite
   keeps the URL bar as /planner). For all other paths, this script is a
   no-op and the captain dashboard renders normally.
   Installed 2026-08-21. */
(function () {
  try {
    var p = location.pathname;
    if (p !== '/planner' && p !== '/planner/') return;

    /* Bare /planner (no trailing slash) — fix URL once, then load viewer. */
    if (p === '/planner') {
      history.replaceState(null, '', '/planner/');
    }

    /* Synchronous fetch of viewer.html. Same-origin; already served by the
       dashboard/planner/ build output (verified 200 OK). We need sync so the
       captain dashboard HTML never paints before we swap it out. */
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'planner/viewer.html', false);
    xhr.send();
    if (xhr.status !== 200) {
      console.error('[planner-spa-router] viewer.html fetch failed', xhr.status);
      return;
    }
    document.open();
    document.write(xhr.responseText);
    document.close();
  } catch (e) {
    console.error('[planner-spa-router] error', e);
  }
})();
