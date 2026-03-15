/* OpsCopilot — browser-safe Supabase client
 *
 * BROWSER-SIDE ONLY. This module uses the anon (public) key only.
 * The service role key is never sent to the browser.
 *
 * SUPABASE_URL and SUPABASE_ANON_KEY are fetched at runtime from
 * /api/auth-config so they are never hard-coded in the client bundle.
 * The anon key is intentionally public — Supabase RLS policies enforce
 * per-user data access.
 *
 * Usage:
 *   import { getClient } from './client/lib/supabaseClient.js';
 *   const supabase = await getClient();   // null when auth is not configured
 *
 * Or, if loaded as a plain <script> tag (no bundler):
 *   const supabase = await window.getSupabaseClient();
 */

(function (root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) {
    // CommonJS / Node — should not be used server-side, but guard anyway.
    module.exports = factory();
  } else {
    // Browser global
    root.getSupabaseClient = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var _client = null;       // cached Supabase client instance
  var _initPromise = null;  // ensures init runs only once

  /** Dynamically load the Supabase UMD bundle from CDN (no build step required). */
  function _loadSDK() {
    return new Promise(function (resolve, reject) {
      if (typeof window !== 'undefined' && window.supabase) {
        resolve();
        return;
      }
      var script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      script.onload  = resolve;
      script.onerror = function () { reject(new Error('Failed to load Supabase SDK from CDN.')); };
      document.head.appendChild(script);
    });
  }

  /**
   * Initialise the Supabase browser client.
   *
   * Fetches SUPABASE_URL and SUPABASE_ANON_KEY from /api/auth-config so
   * credentials are never embedded in the client bundle.
   *
   * @returns {Promise<import('@supabase/supabase-js').SupabaseClient | null>}
   *   The configured client, or null if Supabase is not enabled on the server.
   */
  function getClient() {
    if (_initPromise) return _initPromise;

    _initPromise = (async function () {
      try {
        var res = await fetch('/api/auth-config');
        if (!res.ok) return null;

        var cfg = await res.json();
        if (!cfg.configured || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return null;

        await _loadSDK();

        _client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
          auth: {
            autoRefreshToken: true,
            persistSession: true,
          },
        });

        return _client;
      } catch (_err) {
        // Auth is optional — return null so callers degrade gracefully.
        return null;
      }
    }());

    return _initPromise;
  }

  return getClient;
}));
