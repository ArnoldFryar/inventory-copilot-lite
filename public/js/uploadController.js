/* File input, import review, saved mapping, and run replacement. */
(function () {
  'use strict';

  const { dom, state, track } = window.App;
  const App = window.App;
  const element = id => document.getElementById(id);
  const panel = element('inventoryMapping');
  const fields = element('mappingFields');
  const fieldsByKey = [
    ['part_number', 'Part number', true], ['on_hand', 'On-hand quantity', true],
    ['daily_usage', 'Usage'], ['lead_time', 'Lead time'], ['site', 'Site or warehouse'],
    ['uom', 'On-hand unit'], ['usage_uom', 'Usage unit'], ['supplier', 'Supplier'],
    ['description', 'Description'],
  ];
  let pendingFile;
  let lastReview;
  let requestId = 0;

  function chooseFile() {
    element('inventoryUpload').classList.remove('hidden');
    dom.fileInput.click();
  }

  function markReplacement() {
    const previous = Boolean(state.lastResponse);
    element('previousRunNote').classList.toggle('hidden', !previous);
    element('inventoryUpload').classList.remove('hidden');
  }

  function setFile(file) {
    requestId++;
    pendingFile = file;
    lastReview = null;
    panel.classList.add('hidden');
    dom.fileLabel.textContent = file ? file.name : '';
    dom.fileLabel.classList.toggle('hidden', !file);
    dom.submitBtn.classList.toggle('hidden', !file);
    dom.submitBtn.disabled = !file;
    element('reviewInventoryMapping').classList.toggle('hidden', !file);
    App.hideError();
    if (file) markReplacement();
    element('inventoryUploadStatus').textContent = '';
  }

  element('chooseInventoryFile').addEventListener('click', chooseFile);
  element('newInventoryAnalysis').addEventListener('click', () => {
    markReplacement();
    element('chooseInventoryFile').focus();
  });
  dom.fileInput.addEventListener('change', () => setFile(dom.fileInput.files[0]));
  const uploadSection = element('inventoryUpload');
  uploadSection.addEventListener('dragover', event => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  });
  uploadSection.addEventListener('drop', event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    setFile(event.dataTransfer.files[0]);
  });

  function profileKey() {
    return state.currentUser?.id ? 'opscopilot:inventory-columns:' + state.currentUser.id : null;
  }

  function profiles() {
    try { return profileKey() ? JSON.parse(localStorage.getItem(profileKey()) || '[]') : []; }
    catch (_) { return []; }
  }

  function compatible(profile, review) {
    if ((review.worksheet || '') !== (profile.worksheet || '')) return false;
    if (profile.headerRow !== review.headerRow) return false;
    if (!Object.values(profile.mapping).filter(Boolean).every(value => review.headers.includes(value))) return false;
    return !Object.entries(review.candidates).some(([field, candidates]) =>
      candidates.some(candidate => !profile.headers.includes(candidate) && candidate !== profile.mapping[field]));
  }

  function remember(options) {
    const key = profileKey();
    if (!key || !lastReview) return;
    const candidate = { ...options, headers: lastReview.headers };
    const previous = profiles().filter(profile => !compatible(profile, lastReview));
    try { localStorage.setItem(key, JSON.stringify([candidate, ...previous].slice(0, 12))); }
    catch (_) { element('inventoryUploadStatus').textContent = 'The browser could not remember the mapping.'; }
  }

  function addOption(select, value, label) {
    const choice = document.createElement('option');
    choice.value = value;
    choice.textContent = label;
    select.append(choice);
  }

  function showReview(review, preferred) {
    lastReview = review;
    fields.replaceChildren();
    for (const [key, label, required] of fieldsByKey) {
      const wrap = document.createElement('label');
      wrap.textContent = label + (required ? ' (required)' : '');
      const select = document.createElement('select');
      select.name = key;
      addOption(select, '', required ? 'Choose a column' : 'Unavailable');
      for (const header of review.headers) addOption(select, header, header);
      if (key in (preferred?.mapping || {})) select.value = preferred.mapping[key];
      else select.value = review.mapping[key] || '';
      wrap.append(select);
      fields.append(wrap);
    }
    const sheet = element('mappingSheet');
    sheet.replaceChildren();
    for (const name of review.worksheets || []) addOption(sheet, name, name);
    sheet.value = review.worksheet || '';
    element('mappingSheetField').classList.toggle('hidden', !review.worksheets?.length);
    element('mappingHeaderRow').value = review.headerRow;
    element('mappingUsageBasis').value = preferred?.usagePeriodDays > 1 ? 'total' : 'daily';
    element('mappingUsageDays').value = preferred?.usagePeriodDays > 1 ? preferred.usagePeriodDays : '';
    element('mappingLeadUnits').value = preferred?.leadTimeUnit || 'calendar_days';
    element('mappingUsageBasis').dispatchEvent(new Event('change'));
    element('saveInventoryMappingField').classList.toggle('hidden', !profileKey());
    const preview = document.createElement('table');
    const header = preview.createTHead().insertRow();
    for (const name of review.headers) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = name;
      header.append(cell);
    }
    const body = preview.createTBody();
    for (const values of review.examples) {
      const row = body.insertRow();
      for (const value of values) row.insertCell().textContent = value;
    }
    element('mappingPreview').replaceChildren(preview);
    panel.classList.remove('hidden');
    element('mappingTitle').focus();
  }

  async function analyze(file, options = {}, flags = {}) {
    if (!file || state.inFlight) return;
    if (file.size > 5 * 1024 * 1024) return App.showError('The file exceeds the 5 MB upload limit.');
    const runRequest = ++requestId;
    state.inFlight = true;
    dom.loadSampleBtn.disabled = true;
    App.hideError();
    App.setLoading(true);
    element('inventoryUploadStatus').textContent = flags.inspect ? 'Reading column names…' : 'Analyzing inventory…';

    try {
      const form = new FormData();
      form.append('csvfile', file);
      if (options.mapping) form.append('mapping', JSON.stringify(options.mapping));
      if (options.worksheet) form.append('worksheet', options.worksheet);
      if (options.headerRow) form.append('headerRow', options.headerRow);
      if (options.usagePeriodDays) form.append('usagePeriodDays', options.usagePeriodDays);
      if (options.leadTimeUnit) form.append('leadTimeUnit', options.leadTimeUnit);
      if (flags.inspect) form.append('inspect', 'true');
      if (flags.sample) form.append('sample', 'true');
      const token = await window.authModule?.getToken();
      const response = await fetch('/upload', {
        method: 'POST', body: form,
        headers: token ? { Authorization: 'Bearer ' + token } : {},
      });
      const data = await response.json();
      if (runRequest !== requestId) return;
      if (data.code === 'mapping_required') {
        const saved = profiles().find(profile => compatible(profile, data));
        if (saved && (!flags.inspect || flags.tryProfile)) {
          state.inFlight = false;
          return await analyze(file, saved);
        }
        if (flags.tryProfile && !data.requiresReview) {
          state.inFlight = false;
          return await analyze(file);
        }
        showReview(data, saved);
        return;
      }
      if (!response.ok) throw new Error(data.error || 'The file could not be analyzed.');
      if (flags.remember) remember(options);
      panel.classList.add('hidden');
      state.analysisSource = flags.sample ? 'sample' : 'upload';
      App.resultsRenderer.renderAll(data);
      uploadSection.classList.add('hidden');
      element('analysisTitle').focus();
    } catch (error) {
      if (runRequest === requestId) {
        track('upload_failed', { reason: 'analysis_error' });
        App.showError(error.message || 'The file could not be analyzed.');
      }
    } finally {
      state.inFlight = false;
      dom.loadSampleBtn.disabled = false;
      App.setLoading(false);
      dom.submitBtn.disabled = !pendingFile;
      element('inventoryUploadStatus').textContent = '';
    }
  }

  dom.form.addEventListener('submit', event => {
    event.preventDefault();
    analyze(pendingFile, {}, profiles().length ? { inspect: true, tryProfile: true } : {});
  });
  element('reviewInventoryMapping').addEventListener('click', () => analyze(pendingFile, {}, { inspect: true }));
  function refreshReview() {
    const headerRow = element('mappingHeaderRow');
    if (!headerRow.reportValidity()) return;
    analyze(pendingFile, { worksheet: element('mappingSheet').value, headerRow: headerRow.value }, { inspect: true });
  }
  element('mappingRefresh').addEventListener('click', refreshReview);
  element('mappingSheet').addEventListener('change', () => {
    element('mappingHeaderRow').value = '';
    refreshReview();
  });
  element('mappingUsageBasis').addEventListener('change', event => {
    element('mappingDaysField').classList.toggle('hidden', event.target.value === 'daily');
  });
  element('applyInventoryMapping').addEventListener('click', () => {
    const mapping = Object.fromEntries([...fields.querySelectorAll('select')].map(select => [select.name, select.value]));
    if (!mapping.part_number || !mapping.on_hand) return App.showError('Map part number and on-hand quantity to continue.');
    const useTotal = element('mappingUsageBasis').value === 'total';
    const days = element('mappingUsageDays');
    if (useTotal && (!days.value || !days.checkValidity())) return App.showError('Enter the number of calendar days covered by the usage column.');
    const worksheet = element('mappingSheet').value;
    const headerRow = Number(element('mappingHeaderRow').value);
    if (worksheet !== (lastReview.worksheet || '') || headerRow !== lastReview.headerRow) {
      return App.showError('Refresh the preview after changing the worksheet or header row.');
    }
    analyze(pendingFile, {
      mapping, worksheet, headerRow, usagePeriodDays: useTotal ? Number(days.value) : 1,
      leadTimeUnit: element('mappingLeadUnits').value,
    }, { remember: !element('saveInventoryMappingField').classList.contains('hidden') && element('saveInventoryMapping').checked });
  });

  dom.loadSampleBtn.addEventListener('click', async () => {
    if (state.inFlight) return;
    dom.loadSampleBtn.disabled = true;
    try {
      const response = await fetch('/sample-data');
      if (!response.ok) throw new Error('Could not load the sample file.');
      const file = new File([await response.blob()], 'sample_inventory.csv', { type: 'text/csv' });
      track('sample_loaded');
      await analyze(file, {}, { sample: true });
    } catch (error) { App.showError(error.message); }
    finally { dom.loadSampleBtn.disabled = false; }
  });

  App.resetInventoryUpload = () => {
    dom.fileInput.value = '';
    setFile(null);
    uploadSection.classList.remove('hidden');
    element('previousRunNote').classList.add('hidden');
  };
})();
