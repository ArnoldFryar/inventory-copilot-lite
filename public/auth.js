/* OpsCopilot-Lite — frontend auth module
 *
 * Initialises the Supabase client in the browser and exposes auth helpers
 * consumed by script.js.  The Supabase URL and anon key are fetched from
 * /api/auth-config so they are never hard-coded in the frontend bundle.
 *
 * Exposes on window.authModule:
 *   init()           — fetch config and create the Supabase client
 *   signUp(email,pw) — create a new account
 *   signIn(email,pw) — sign in with email & password
 *   signOut()        — sign out
 *   getSession()     — returns the current session (or null)
 *   getToken()       — returns the access token string (or null)
 *   onAuthChange(cb) — registers a listener; cb(event, session)
 *   isConfigured()   — true once Supabase is ready
 */

(function () {
  'use strict';

  var _supabase = null;       // Supabase client instance
  var _configured = false;

  // Dynamically load the Supabase browser bundle from CDN.
  // This avoids bundler complexity — the app has no build step.
  function loadSupabaseSDK() {
    return new Promise(function (resolve, reject) {
      if (window.supabase) { resolve(); return; }
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      s.onload  = resolve;
      s.onerror = function () { reject(new Error('Failed to load Supabase SDK')); };
      document.head.appendChild(s);
    });
  }

  async function init() {
    try {
      var res = await fetch('/api/auth-config');
      if (!res.ok) return;
      var cfg = await res.json();
      if (!cfg.configured) return;

      await loadSupabaseSDK();
      _supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      _configured = true;
    } catch (_) {
      // Auth is optional — fail silently so the core tool stays usable.
    }
  }

  function isConfigured() { return _configured; }

  async function signUp(email, password) {
    if (!_supabase) throw new Error('Auth not configured');
    var result = await _supabase.auth.signUp({ email: email, password: password });
    if (result.error) throw new Error(result.error.message);
    return result.data;
  }

  async function signIn(email, password) {
    if (!_supabase) throw new Error('Auth not configured');
    var result = await _supabase.auth.signInWithPassword({ email: email, password: password });
    if (result.error) throw new Error(result.error.message);
    return result.data;
  }

  async function signOut() {
    if (!_supabase) return;
    await _supabase.auth.signOut();
  }

  async function getSession() {
    if (!_supabase) return null;
    var result = await _supabase.auth.getSession();
    return result.data?.session || null;
  }

  async function getToken() {
    var session = await getSession();
    return session ? session.access_token : null;
  }

  function onAuthChange(callback) {
    if (!_supabase) return { data: { subscription: { unsubscribe: function () {} } } };
    return _supabase.auth.onAuthStateChange(callback);
  }

  window.authModule = {
    init: init,
    signUp: signUp,
    signIn: signIn,
    signOut: signOut,
    getSession: getSession,
    getToken: getToken,
    onAuthChange: onAuthChange,
    isConfigured: isConfigured
  };
})();
