/* gsi-auth.js — Google Identity Services → Supabase signInWithIdToken helper
 *
 * Implements the GSI + signInWithIdToken flow proven on FishEdge (2026-08-04):
 *   https://accounts.google.com/gsi/client → google.accounts.id.initialize + renderButton
 *   → google.accounts.id.renderButton → callback receives { credential }
 *   → sb.auth.signInWithIdToken({ provider: 'google', token: credential })
 *
 * Usage (per page):
 *   <script src="https://accounts.google.com/gsi/client" async defer></script>
 *   <script src="gsi-auth.js"></script>
 *   <script>
 *     window.gsiAuth.initGoogleSignIn({
 *       onSuccess: (session) => { /* redirect on success *|/ },
 *       onError:   (msg)     => { /* show error *|/ },
 *     });
 *   </script>
 *
 * The GSI button HTML container (<div id="gsi-button">) must be present in the page
 * before initGoogleSignIn() is called.
 *
 * Key insight (FishEdge 2026-08-04): GSI bypasses Supabase's hosted OAuth redirect,
 * so the Google consent screen shows the brand domain (e.g. app.fishedge.live)
 * instead of *.supabase.co. No paid custom auth domain needed.
 */
(function () {
  'use strict';

  /* ── GSI client ID ─────────────────────────────────────────────────────────
   * FishEdge uses this OAuth 2.0 client (Google Cloud console → APIs & Services
   * → Credentials → Web client). The same client is authorised for GSI JS-origin
   * usage on both the GitHub Pages deployment and the custom-domain equivalent.
   * If you see "EREQ{...} redirect_uri_mismatch" in the browser console, the
   * OAuth client needs app.fishedge.live (or the deploying origin) added to
   * "Authorised JavaScript origins" in the Google Cloud console — no redirect
   * URI changes are needed for GSI.
   */
  var GSI_CLIENT_ID = '888175087139-ka81ic2ojma1ltmf0f6fc5krk0ua8hmj.apps.googleusercontent.com';

  /* ── Public API ───────────────────────────────────────────────────────────── */
  window.gsiAuth = {
    /**
     * Initialise Google Sign-In and render the GSI button.
     *
     * @param {Object} opts
     * @param {Function} opts.onSuccess  – called with the Supabase session on success
     * @param {Function} opts.onError    – called with an error string on failure
     * @param {string}  [opts.containerId='gsi-button'] – id of the div that hosts the button
     */
    initGoogleSignIn: function (opts) {
      opts = opts || {};
      var containerId = opts.containerId || 'gsi-button';
      var onSuccess   = opts.onSuccess   || function () {};
      var onError     = opts.onError     || function () {};

      var container = document.getElementById(containerId);
      if (!container) {
        onError('gsi-auth: #' + containerId + ' not found in DOM — add <div id="gsi-button"></div> before gsi-auth.js');
        return;
      }

      /* Global callback invoked by Google's GSI library when the user completes
       * the Google sign-in flow. */
      window.handleGoogleCredential = function (response) {
        /* response.credential is a Google-issued JWT id_token. */
        if (!response.credential) {
          onError('No credential in Google response.');
          return;
        }
        var sb = window.sb;
        if (!sb) {
          onError('Supabase client (window.sb) not initialised — is supabase-init.js loaded?');
          return;
        }
        sb.auth.signInWithIdToken({
          provider: 'google',
          token:    response.credential,
        }).then(function (_ref) {
          var data  = _ref.data;
          var error = _ref.error;
          if (error) {
            onError('signInWithIdToken failed: ' + error.message);
            return;
          }
          onSuccess(data && data.session);
        }).catch(function (e) {
          onError('signInWithIdToken threw: ' + (e && e.message));
        });
      };

      /* If the GSI library is already loaded, initialise immediately.
       * Otherwise the onload callback below will handle it when it arrives. */
      if (window.google && window.google.accounts) {
        doInit();
      } else {
        window.__gsiOnLoadCallback = doInit;
      }

      function doInit() {
        try {
          window.google.accounts.id.initialize({
            client_id:             GSI_CLIENT_ID,
            callback:              window.handleGoogleCredential,
            cancel_on_tap_outside: false,
            itp_support:           true,
          });
        } catch (e) {
          onError('GSI initialize failed: ' + (e && e.message));
          return;
        }
        try {
          window.google.accounts.id.renderButton(
            container,
            {
              type:          'standard',
              theme:         'outline',
              size:          'large',
              text:          'continue_with',
              shape:         'rectangular',
              logo_alignment:'left',
              width:         Math.min(container.offsetWidth || 380, 380),
            }
          );
        } catch (e) {
          /* renderButton can fail if the container has zero width; retry with a
           * sensible default width. */
          try {
            window.google.accounts.id.renderButton(container, {
              type:          'standard',
              theme:         'outline',
              size:          'large',
              text:          'continue_with',
              shape:         'rectangular',
              logo_alignment:'left',
              width:         380,
            });
          } catch (e2) {
            onError('GSI renderButton failed: ' + (e2 && e2.message));
          }
        }
      }
    },
  };

  /* Auto-wire the GSI library load callback if set before this script ran. */
  if (window.__gsiOnLoadCallback) {
    window.gsiAuth.initGoogleSignIn(window.__gsiOpts || {});
  }
})();
