/* aiHistoryStore.js — lightweight localStorage-backed AI draft history. */
(function () {
  'use strict';

  var STORAGE_KEY = 'opscopilot_ai_history';
  var MAX_ENTRIES = 30;

  function _read() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  }

  function _write(entries) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch (_) { /* quota */ }
  }

  /** Save a new AI draft entry. */
  function saveEntry(entry) {
    var entries = _read();
    entries.unshift({
      id:         Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      helperType: entry.helperType,
      label:      entry.label,
      output:     entry.output,
      timestamp:  entry.timestamp || new Date().toISOString(),
    });
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    _write(entries);
  }

  /** Return all entries, newest first. */
  function getEntries() {
    return _read();
  }

  /** Return entries grouped by helperType. */
  function getGrouped() {
    var entries = _read();
    var groups = {};
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!groups[e.helperType]) groups[e.helperType] = [];
      groups[e.helperType].push(e);
    }
    return groups;
  }

  /** Delete a single entry by id. */
  function removeEntry(id) {
    var entries = _read();
    _write(entries.filter(function (e) { return e.id !== id; }));
  }

  /** Clear all history. */
  function clearHistory() {
    localStorage.removeItem(STORAGE_KEY);
  }

  window.App.aiHistoryStore = {
    saveEntry:    saveEntry,
    getEntries:   getEntries,
    getGrouped:   getGrouped,
    removeEntry:  removeEntry,
    clearHistory: clearHistory,
    MAX_ENTRIES:  MAX_ENTRIES,
  };
})();
