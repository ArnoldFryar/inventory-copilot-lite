/* historyManager.js â€” saved analysis run history panel. */
(function () {
  'use strict';

  var App   = window.App;
  var dom   = App.dom;
  var state = App.state;
  var track = App.track;

  // â”€â”€ State for UI controls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  var _allRuns = [];      // full fetched list
  var _searchTerm = '';
  var _sortOrder  = 'newest';

  // â”€â”€ Save to History â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
        // Silent â€” user can retry with the manual Save button.
      } finally {
        state.autoSaveInFlight = false;
      }
    })();
  }

  // â”€â”€ History panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
      if (dom.historyToolbar) dom.historyToolbar.classList.add('hidden');
      if (dom.historyCount)   dom.historyCount.classList.add('hidden');
      dom.historySignIn.classList.remove('hidden');
      return;
    }

    dom.historySignIn.classList.add('hidden');

    if (!canAccess) {
      while (dom.historyList.firstChild) dom.historyList.removeChild(dom.historyList.firstChild);
      dom.historyEmpty.classList.add('hidden');
      if (dom.historyToolbar) dom.historyToolbar.classList.add('hidden');
      if (dom.historyCount)   dom.historyCount.classList.add('hidden');
      if (dom.historyUpgrade) {
        dom.historyUpgrade.classList.remove('hidden');
        while (dom.historyUpgrade.firstChild) dom.historyUpgrade.removeChild(dom.historyUpgrade.firstChild);
        var cta = App.buildUpsellCta({
          icon: '\uD83D\uDDC2\uFE0F',
          headline: 'Build an Audit Trail for Every Review Cycle',
          description: 'Every analysis is saved automatically. Compare runs side-by-side, track risk trends over time, and show leadership measurable improvement.',
          features: ['Unlimited saved runs', 'Side-by-side run comparison', 'Search & filter by date or filename', 'Instant access to past reports'],
          showBtn: state.billingConfigured !== false,
          btnText: 'Unlock Run History · $49/mo →',
          valueAnchor: 'Replaces hours of manual inventory triage every week.',
        });
        dom.historyUpgrade.appendChild(cta);
      }
      return;
    }
    if (dom.historyUpgrade) dom.historyUpgrade.classList.add('hidden');

    try {
      var token = await window.authModule.getToken();
      var res = await fetch('/api/runs?module=inventory', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!res.ok) throw new Error('fetch failed');
      var runs = await res.json();
      _allRuns = runs || [];
      _wireToolbar();
      _applyFiltersAndRender();
    } catch (_) {
      dom.historyEmpty.textContent = 'Could not load history.';
      dom.historyEmpty.classList.remove('hidden');
    }
  }

  // â”€â”€ Toolbar wiring (search + sort) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  var _toolbarWired = false;

  function _wireToolbar() {
    if (!dom.historyToolbar) return;
    if (_allRuns.length > 0) {
      dom.historyToolbar.classList.remove('hidden');
    } else {
      dom.historyToolbar.classList.add('hidden');
    }

    if (_toolbarWired) return;
    _toolbarWired = true;

    if (dom.historySearch) {
      dom.historySearch.addEventListener('input', function () {
        _searchTerm = this.value.trim().toLowerCase();
        _applyFiltersAndRender();
      });
    }

    if (dom.historySort) {
      dom.historySort.addEventListener('change', function () {
        _sortOrder = this.value;
        _applyFiltersAndRender();
      });
    }
  }

  function _applyFiltersAndRender() {
    var filtered = _allRuns.filter(function (run) {
      if (!_searchTerm) return true;
      var name = (run.file_name || '').toLowerCase();
      return name.indexOf(_searchTerm) !== -1;
    });

    filtered = filtered.slice(); // copy before sort
    if (_sortOrder === 'newest') {
      filtered.sort(function (a, b) { return new Date(b.uploaded_at) - new Date(a.uploaded_at); });
    } else if (_sortOrder === 'oldest') {
      filtered.sort(function (a, b) { return new Date(a.uploaded_at) - new Date(b.uploaded_at); });
    } else if (_sortOrder === 'name') {
      filtered.sort(function (a, b) { return (a.file_name || '').localeCompare(b.file_name || ''); });
    } else if (_sortOrder === 'parts-desc') {
      filtered.sort(function (a, b) { return (b.part_count || 0) - (a.part_count || 0); });
    }

    _renderHistoryList(filtered, _allRuns.length);
  }

  // â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function _renderHistoryList(runs, totalCount) {
    while (dom.historyList.firstChild) dom.historyList.removeChild(dom.historyList.firstChild);

    // Count label
    if (dom.historyCount) {
      if (totalCount > 0) {
        dom.historyCount.classList.remove('hidden');
        if (_searchTerm && runs.length !== totalCount) {
          dom.historyCount.textContent = runs.length + ' of ' + totalCount + ' runs match';
        } else {
          dom.historyCount.textContent = totalCount + (totalCount === 1 ? ' run' : ' runs');
        }
      } else {
        dom.historyCount.classList.add('hidden');
      }
    }

    if (!runs || runs.length === 0) {
      dom.historyEmpty.classList.remove('hidden');
      dom.historyEmpty.textContent = _searchTerm ? 'No runs match \u201c' + _searchTerm + '\u201d.' : 'No saved runs yet.';
      return;
    }
    dom.historyEmpty.classList.add('hidden');

    runs.forEach(function (run, idx) {
      var li = document.createElement('li');
      li.className = 'history-item';

      // â”€â”€ Info column â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

      // Date
      var meta = document.createElement('span');
      meta.className = 'history-item-meta';
      var d = run.uploaded_at ? new Date(run.uploaded_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
      meta.textContent = d;
      info.appendChild(meta);

      // Row count
      if (run.part_count) {
        var rowCount = document.createElement('span');
        rowCount.className = 'history-item-counts';
        rowCount.textContent = (run.part_count || 0) + ' parts';

        // Append summary chips
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
          rowCount.textContent += ' \u00b7 ' + chips.join(' \u00b7 ');
        }
        info.appendChild(rowCount);
      }

      li.appendChild(info);

      // â”€â”€ Actions column â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      var actions = document.createElement('div');
      actions.className = 'history-item-actions';

      var loadBtn = document.createElement('button');
      loadBtn.className = 'link-btn';
      loadBtn.textContent = 'Load';
      loadBtn.type = 'button';
      loadBtn.addEventListener('click', function () { loadHistoryRun(run.id); });
      actions.appendChild(loadBtn);

      // Compare button â€” only show when there are at least 2 runs and this
      // isn't the very last (oldest) one in the sorted list.
      if (runs.length >= 2 && idx < runs.length - 1) {
        var cmpBtn = document.createElement('button');
        cmpBtn.className = 'history-compare-btn';
        cmpBtn.textContent = 'Compare \u2192';
        cmpBtn.type = 'button';
        cmpBtn.title = 'Compare to previous run';
        cmpBtn.addEventListener('click', function () {
          compareToRun(run.id, cmpBtn, li);
        });
        actions.appendChild(cmpBtn);
      }

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

  // â”€â”€ Compare a history run against its predecessor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function compareToRun(runId, btn, li) {
    btn.disabled = true;
    btn.textContent = 'Loading\u2026';

    try {
      var token = await window.authModule.getToken();
      var res = await fetch('/api/runs/' + encodeURIComponent(runId) + '/compare', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!res.ok) throw new Error('compare failed');
      var cmp = await res.json();

      // Render the full comparison panel (reuse existing renderer)
      App.comparisonRenderer.fetchAndRenderComparison(runId, token);

      // Render an inline delta badge row on the card
      _renderDeltaBadge(li, cmp);

      btn.textContent = 'Compared \u2713';
      track('history_compare_clicked');
    } catch (_) {
      btn.textContent = 'Compare \u2192';
      btn.disabled = false;
    }
  }

  function _renderDeltaBadge(li, cmp) {
    // Remove any existing delta row
    var existing = li.querySelector('.history-delta-row');
    if (existing) existing.parentNode.removeChild(existing);

    if (!cmp || !cmp.hasPrior) return;

    var row = document.createElement('div');
    row.className = 'history-delta-row';

    var label = document.createElement('span');
    label.className = 'history-delta-label';
    label.textContent = 'vs prev:';
    row.appendChild(label);

    function addChip(count, text, cls) {
      if (!count) return;
      var chip = document.createElement('span');
      chip.className = 'history-delta-chip ' + cls;
      chip.textContent = (count > 0 ? '+' : '') + count + ' ' + text;
      row.appendChild(chip);
    }

    addChip(cmp.newUrgent?.length,      'new urgent',     'delta-worse');
    addChip(cmp.resolvedUrgent?.length, 'resolved',       'delta-better');
    addChip(cmp.worsened?.length,       'worsened',       'delta-worse');
    addChip(cmp.improved?.length,       'improved',       'delta-better');

    var urgentDelta = (cmp.newUrgent?.length || 0) - (cmp.resolvedUrgent?.length || 0);
    if (row.children.length === 1) {
      // Only the label, no changes
      var chip = document.createElement('span');
      chip.className = 'history-delta-chip delta-neutral';
      chip.textContent = 'No change';
      row.appendChild(chip);
    }

    li.appendChild(row);
  }

  // â”€â”€ Load / Delete â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
        // Hide save button â€” this run is already persisted
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
      // Remove from local cache
      _allRuns = _allRuns.filter(function (r) { return r.id !== runId; });
      if (listItem && listItem.parentNode) listItem.parentNode.removeChild(listItem);
      // Re-apply filters so count & empty state stay accurate
      _applyFiltersAndRender();
      if (_allRuns.length === 0 && dom.historyToolbar) {
        dom.historyToolbar.classList.add('hidden');
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
