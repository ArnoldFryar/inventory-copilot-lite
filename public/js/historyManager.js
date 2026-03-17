/* historyManager.js — saved analysis run history panel. */
(function () {
  'use strict';

  var App   = window.App;
  var dom   = App.dom;
  var state = App.state;
  var track = App.track;

  // ── Save to History ──────────────────────────────────────────────────────

  dom.saveRunBtn.addEventListener('click', async function () {
    if (!state.lastResponse || !state.currentUser) return;
    dom.saveRunBtn.disabled = true;
    dom.saveRunBtn.textContent = 'Saving\u2026';

    try {
      var token = await window.authModule.getToken();
      var fname = dom.fileInput.files[0] ? dom.fileInput.files[0].name : 'unknown';
      var isSample = fname === 'sample_inventory.csv';
      var body = {
        file_name: fname,
        part_count: state.lastResponse.summary?.total || 0,
        summary_json: {
          counts: state.lastResponse.summary,
          topPriority: state.lastResponse.topPriority || [],
          thresholds: state.lastResponse.thresholds || {},
          columnAliases: state.lastResponse.columnAliases || {}
        },
        results_json: state.lastResponse.results,
        plan_at_upload: state.currentPlan?.plan || 'free',
        source_type: isSample ? 'sample' : 'manual'
      };
      var res = await fetch('/api/runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        var data = await res.json().catch(function () { return {}; });
        throw new Error(data.error || 'Save failed');
      }
      dom.saveRunBtn.textContent = 'Saved \u2713';
      track('run_saved');
      refreshHistory();
      setTimeout(function () { dom.saveRunBtn.textContent = 'Save to History'; dom.saveRunBtn.disabled = false; }, 2000);
    } catch (err) {
      App.showError(err.message || 'Could not save analysis run.');
      dom.saveRunBtn.textContent = 'Save to History';
      dom.saveRunBtn.disabled = false;
    }
  });

  // Fire-and-forget auto-save after fresh uploads for signed-in Pro users.
  // On success, also trigger a comparison against the previous run.
  function autoSaveRun(data) {
    if (!state.currentUser) return;
    if (!state.currentPlan || !state.currentPlan.entitlements.savedHistory) return;
    if (!window.authModule || !window.authModule.isConfigured()) return;
    if (state.autoSaveInFlight) return;
    state.autoSaveInFlight = true;

    (async function () {
      try {
        var token = await window.authModule.getToken();
        if (!token) return;
        var fname = dom.fileInput.files[0] ? dom.fileInput.files[0].name : 'unknown';
        var isSample = fname === 'sample_inventory.csv';
        var body = {
          file_name: fname,
          part_count: data.summary?.total || 0,
          summary_json: {
            counts: data.summary,
            topPriority: data.topPriority || [],
            thresholds: data.thresholds || {},
            columnAliases: data.columnAliases || {}
          },
          results_json: data.results,
          plan_at_upload: state.currentPlan?.plan || 'free',
          source_type: isSample ? 'sample' : 'manual'
        };
        var res = await fetch('/api/runs', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token
          },
          body: JSON.stringify(body)
        });
        if (res.ok) {
          var saved = await res.json().catch(function () { return null; });
          if (dom.saveRunBtn) {
            dom.saveRunBtn.textContent = 'Saved \u2713';
            dom.saveRunBtn.disabled = true;
          }
          track('run_auto_saved');
          refreshHistory();
          // Fetch comparison against the prior run (silent on failure)
          if (saved && saved.id) {
            App.comparisonRenderer.fetchAndRenderComparison(saved.id, token);
          }
        }
      } catch (_) {
        // Silent — user can retry with the manual Save button.
      } finally {
        state.autoSaveInFlight = false;
      }
    })();
  }

  // ── History panel ────────────────────────────────────────────────────────

  async function refreshHistory() {
    if (!window.authModule || !window.authModule.isConfigured()) {
      dom.historySection.classList.add('hidden');
      return;
    }

    var canAccess = state.currentPlan && state.currentPlan.entitlements.savedHistory;

    // Show the section to prompt sign-in or upgrade
    dom.historySection.classList.remove('hidden');

    if (!state.currentUser) {
      while (dom.historyList.firstChild) dom.historyList.removeChild(dom.historyList.firstChild);
      dom.historyEmpty.classList.add('hidden');
      if (dom.historyUpgrade) dom.historyUpgrade.classList.add('hidden');
      dom.historySignIn.classList.remove('hidden');
      return;
    }

    dom.historySignIn.classList.add('hidden');

    if (!canAccess) {
      while (dom.historyList.firstChild) dom.historyList.removeChild(dom.historyList.firstChild);
      dom.historyEmpty.classList.add('hidden');
      if (dom.historyUpgrade) dom.historyUpgrade.classList.remove('hidden');
      return;
    }
    if (dom.historyUpgrade) dom.historyUpgrade.classList.add('hidden');

    try {
      var token = await window.authModule.getToken();
      var res = await fetch('/api/runs', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!res.ok) throw new Error('fetch failed');
      var runs = await res.json();
      renderHistoryList(runs);
    } catch (_) {
      dom.historyEmpty.textContent = 'Could not load history.';
      dom.historyEmpty.classList.remove('hidden');
    }
  }

  function renderHistoryList(runs) {
    while (dom.historyList.firstChild) dom.historyList.removeChild(dom.historyList.firstChild);

    if (!runs || runs.length === 0) {
      dom.historyEmpty.classList.remove('hidden');
      return;
    }
    dom.historyEmpty.classList.add('hidden');

    runs.forEach(function (run) {
      var li = document.createElement('li');
      li.className = 'history-item';

      var info = document.createElement('div');
      info.className = 'history-item-info';

      // File name + optional source badge
      var nameRow = document.createElement('span');
      nameRow.className = 'history-item-name';
      nameRow.textContent = run.file_name || 'Untitled';
      if (run.source_type === 'sample') {
        var badge = document.createElement('span');
        badge.className = 'history-source-badge';
        badge.textContent = 'sample';
        nameRow.appendChild(document.createTextNode(' '));
        nameRow.appendChild(badge);
      }
      info.appendChild(nameRow);

      // Date + part count
      var meta = document.createElement('span');
      meta.className = 'history-item-meta';
      var d = run.uploaded_at ? new Date(run.uploaded_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
      meta.textContent = (run.part_count || 0) + ' parts \u00b7 ' + d;
      info.appendChild(meta);

      // Summary counts (compact one-liner of non-zero categories)
      var sj = run.summary_json || {};
      var counts = sj.counts || sj;
      var chips = [];
      if (counts.urgent_stockout) chips.push(counts.urgent_stockout + ' urgent');
      if (counts.stockout_risk)   chips.push(counts.stockout_risk + ' at risk');
      if (counts.excess)          chips.push(counts.excess + ' excess');
      if (counts.dead_stock)      chips.push(counts.dead_stock + ' dead stock');
      if (counts.no_usage)        chips.push(counts.no_usage + ' no usage');
      if (counts.healthy)         chips.push(counts.healthy + ' healthy');
      if (counts.invalid)         chips.push(counts.invalid + ' invalid');
      if (chips.length > 0) {
        var countsEl = document.createElement('span');
        countsEl.className = 'history-item-counts';
        countsEl.textContent = chips.join(' \u00b7 ');
        info.appendChild(countsEl);
      }

      li.appendChild(info);

      var actions = document.createElement('div');
      actions.className = 'history-item-actions';

      var loadBtn = document.createElement('button');
      loadBtn.className = 'link-btn';
      loadBtn.textContent = 'Load';
      loadBtn.type = 'button';
      loadBtn.addEventListener('click', function () { loadHistoryRun(run.id); });
      actions.appendChild(loadBtn);

      var delBtn = document.createElement('button');
      delBtn.className = 'link-btn history-delete-btn';
      delBtn.textContent = 'Delete';
      delBtn.type = 'button';
      delBtn.addEventListener('click', function () { deleteHistoryRun(run.id, li); });
      actions.appendChild(delBtn);

      li.appendChild(actions);
      dom.historyList.appendChild(li);
    });
  }

  async function loadHistoryRun(runId) {
    try {
      var token = await window.authModule.getToken();
      var res = await fetch('/api/runs/' + encodeURIComponent(runId), {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!res.ok) throw new Error('Not found');
      var run = await res.json();
      // Reconstruct a data shape compatible with renderAll()
      if (run.results_json && run.summary_json) {
        var sj = run.summary_json;
        var counts = sj.counts || sj;
        var data = {
          summary: counts,
          results: run.results_json,
          analyzedAt: run.uploaded_at,
          topPriority: sj.topPriority || [],
          thresholds: sj.thresholds || state.lastResponse?.thresholds || {},
          columnAliases: sj.columnAliases || {},
          resultsTruncated: false
        };
        App.resultsRenderer.renderAll(data);
        // Hide save button — this run is already persisted
        if (dom.saveRunBtn) dom.saveRunBtn.classList.add('hidden');
        track('history_run_loaded');
        // Fetch comparison against the run's predecessor
        App.comparisonRenderer.fetchAndRenderComparison(run.id, token);
      }
    } catch (err) {
      App.showError('Could not load saved run.');
    }
  }

  async function deleteHistoryRun(runId, listItem) {
    try {
      var token = await window.authModule.getToken();
      var res = await fetch('/api/runs/' + encodeURIComponent(runId), {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!res.ok) throw new Error('Delete failed');
      if (listItem && listItem.parentNode) listItem.parentNode.removeChild(listItem);
      // Check if list is now empty
      if (dom.historyList.children.length === 0) {
        dom.historyEmpty.classList.remove('hidden');
      }
      track('history_run_deleted');
    } catch (err) {
      App.showError('Could not delete saved run.');
    }
  }

  App.historyManager = {
    refreshHistory: refreshHistory,
    autoSaveRun:    autoSaveRun,
  };
})();
