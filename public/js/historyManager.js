/* Explicit run saves and account-scoped history. */
(function () {
  'use strict';

  const App = window.App;
  const { dom, state, track } = App;
  const more = document.getElementById('historyMore');
  const deleteDialog = document.getElementById('deleteRunDialog');
  let allRuns = [];
  let nextPage = 1;
  let requestGeneration = 0;
  let deleteTarget;
  let deleteTrigger;

  async function authHeaders() {
    const token = await window.authModule.getToken();
    if (!token) throw new Error('Sign in to access saved runs.');
    return { Authorization: 'Bearer ' + token };
  }

  async function json(response) {
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'The request failed.');
    return value;
  }

  function node(tag, text, className) {
    const result = document.createElement(tag);
    result.textContent = text;
    if (className) result.className = className;
    return result;
  }

  function showMessage(message) {
    dom.historyEmpty.textContent = message;
    dom.historyEmpty.classList.toggle('hidden', !message);
  }

  dom.historySignInBtn.addEventListener('click', () => App.authUI.openAuthModal('signin'));

  function renderHistory() {
    const query = dom.historySearch.value.trim().toLowerCase();
    const hits = allRuns.filter(run => (run.file_name || '').toLowerCase().includes(query));
    const sort = dom.historySort.value;
    if (sort === 'oldest') hits.reverse();
    if (sort === 'name') hits.sort((a, b) => a.file_name.localeCompare(b.file_name));
    if (sort === 'parts-desc') hits.sort((a, b) => b.part_count - a.part_count);
    dom.historyList.replaceChildren();
    for (const run of hits) {
      const item = node('li', '', 'history-item');
      const details = node('div', '', 'history-item-info');
      const date = new Date(run.uploaded_at).toLocaleString();
      details.append(node('strong', run.file_name), node('small', date + ' · ' + run.part_count + ' rows' +
        (run.source_type === 'sample' ? ' · Sample' : '')));
      const actions = node('div', '', 'history-item-actions');
      const open = node('button', 'Open');
      open.type = 'button';
      open.setAttribute('aria-label', 'Open ' + run.file_name);
      open.addEventListener('click', () => loadRun(run.id, open));
      const remove = node('button', 'Delete');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Delete ' + run.file_name);
      remove.addEventListener('click', () => {
        deleteTrigger = remove;
        deleteTarget = run;
        deleteDialog.returnValue = 'cancel';
        deleteDialog.showModal();
      });
      actions.append(open, remove);
      item.append(details, actions);
      dom.historyList.append(item);
    }
    dom.historyToolbar.classList.toggle('hidden', !allRuns.length);
    dom.historyCount.textContent = hits.length + ' loaded runs';
    dom.historyCount.classList.toggle('hidden', !allRuns.length);
    showMessage(hits.length ? '' : query ? 'No loaded runs match this search.' : 'No saved analyses yet.');
  }

  async function refreshHistory(append = false) {
    const generation = ++requestGeneration;
    more.disabled = true;
    if (!append) {
      allRuns = [];
      nextPage = 1;
      dom.historyList.replaceChildren();
      dom.historyToolbar.classList.add('hidden');
      dom.historyCount.classList.add('hidden');
      more.classList.add('hidden');
    }
    dom.historySection.classList.remove('hidden');
    const signedIn = Boolean(state.currentUser);
    dom.historySignIn.classList.toggle('hidden', signedIn || !window.authModule?.isConfigured());
    if (!signedIn) {
      showMessage(window.authModule?.isConfigured() ? '' : 'Saved history requires account access.');
      return;
    }
    showMessage('Loading saved analyses…');
    try {
      const response = await fetch('/api/runs?module=inventory&page=' + nextPage, { headers: await authHeaders() });
      const runs = await json(response);
      if (generation !== requestGeneration) return;
      allRuns = [...new Map([...allRuns, ...runs].map(run => [run.id, run])).values()];
      nextPage++;
      more.classList.toggle('hidden', response.headers.get('X-History-Has-More') !== 'true');
      renderHistory();
    } catch (error) {
      if (generation === requestGeneration) showMessage(error.message);
    } finally {
      if (generation === requestGeneration) more.disabled = false;
    }
  }

  more.addEventListener('click', () => refreshHistory(true));
  dom.historySearch.addEventListener('input', renderHistory);
  dom.historySort.addEventListener('change', renderHistory);

  dom.saveRunBtn.addEventListener('click', async () => {
    const run = state.lastResponse;
    if (!run?.analysisId || run.savedRunId) return;
    dom.saveRunBtn.disabled = true;
    dom.saveRunBtn.textContent = 'Saving…';
    try {
      const response = await fetch('/api/runs', {
        method: 'POST', headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ analysisId: run.analysisId }),
      });
      const saved = await json(response);
      if (run === state.lastResponse) {
        run.savedRunId = saved.id;
        dom.saveRunBtn.textContent = 'Saved';
        configureComparison(run.savedRunId);
      }
      track('run_saved');
      if (state.currentUser) refreshHistory();
    } catch (error) {
      if (run === state.lastResponse) {
        dom.saveRunBtn.disabled = false;
        dom.saveRunBtn.textContent = 'Retry save';
        App.showError(error.message);
      }
    }
  });

  async function loadRun(id, trigger) {
    trigger.disabled = true;
    const owner = state.currentUser?.id;
    try {
      const response = await fetch('/api/runs/' + encodeURIComponent(id), { headers: await authHeaders() });
      const run = await json(response);
      if (state.currentUser?.id !== owner) return;
      const summary = run.summary_json || {};
      const rows = run.results_json || [];
      const counts = { ...(summary.counts || summary), total: run.part_count };
      App.hideError();
      state.analysisSource = run.source_type === 'sample' ? 'sample' : 'history';
      App.resultsRenderer.renderAll({
        summary: counts, results: rows, savedRunId: run.id, sourceType: run.source_type,
        topPriority: summary.topPriority, thresholds: summary.thresholds,
        columnMapping: summary.columnMapping || summary.columnAliases, worksheet: summary.worksheet,
        usagePeriodDays: summary.usagePeriodDays, leadTimeUnit: summary.leadTimeUnit,
        duplicateCount: summary.duplicateCount,
        fileName: run.file_name, ruleVersion: summary.ruleVersion, analyzedAt: summary.analyzedAt || run.uploaded_at,
        resultsTruncated: run.completeness === 'preview' || rows.length < run.part_count,
      });
      document.getElementById('inventoryUpload').classList.add('hidden');
      document.getElementById('analysisTitle').focus();
      configureComparison(run.id);
      track('history_run_loaded');
    } catch (error) { showMessage(error.message); }
    finally { trigger.disabled = false; }
  }

  function configureComparison(runId) {
    const select = document.getElementById('comparisonBaseline');
    select.replaceChildren(new Option('Most recent compatible run', ''));
    const target = allRuns.find(run => run.id === runId);
    for (const candidate of allRuns) {
      if (candidate.id !== runId && candidate.source_type === 'manual' &&
        (!target || candidate.uploaded_at < target.uploaded_at)) {
        select.add(new Option(candidate.file_name + ' · ' + new Date(candidate.uploaded_at).toLocaleDateString(), candidate.id));
      }
    }
    select.onchange = () => App.comparisonRenderer.fetchAndRenderComparison(runId, null, select.value);
    App.comparisonRenderer.fetchAndRenderComparison(runId);
  }

  deleteDialog.addEventListener('close', async () => {
    deleteTrigger?.focus();
    if (deleteDialog.returnValue !== 'delete' || !deleteTarget) return;
    const run = deleteTarget;
    try {
      const response = await fetch('/api/runs/' + encodeURIComponent(run.id), {
        method: 'DELETE', headers: await authHeaders(),
      });
      if (!response.ok) throw new Error('The run could not be deleted.');
      if (state.lastResponse?.savedRunId === run.id) {
        App.hideResults();
        App.resetInventoryUpload();
      }
      track('history_run_deleted');
      await refreshHistory();
      const next = dom.historyList.querySelector('button') || dom.historySection.querySelector('h2');
      if (next) {
        next.setAttribute('tabindex', next.tagName === 'H2' ? '-1' : '0');
        next.focus();
      }
    } catch (error) { showMessage(error.message); }
  });

  App.historyManager = { refreshHistory };
})();
