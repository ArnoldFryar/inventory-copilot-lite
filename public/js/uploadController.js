/* uploadController.js — file upload, sample-data loading, and live-demo. */
(function () {
  'use strict';

  var App   = window.App;
  var dom   = App.dom;
  var state = App.state;
  var track = App.track;

  // ── File selection ────────────────────────────────────────────────────────
  dom.fileInput.addEventListener('change', function () {
    var file = dom.fileInput.files[0];
    if (file) {
      dom.fileLabel.textContent = file.name;
      dom.submitBtn.disabled = false;
    } else {
      dom.fileLabel.textContent = 'Choose a CSV file\u2026';
      dom.submitBtn.disabled = true;
    }
    App.hideError();
    App.hideResults();
  });

  // ── Form submit ───────────────────────────────────────────────────────────
  dom.form.addEventListener('submit', async function (event) {
    event.preventDefault();
    App.hideError();
    App.hideResults();
    if (dom.demoBadge) dom.demoBadge.classList.add('hidden');

    var file = dom.fileInput.files[0];
    if (!file) {
      App.showError('Please select a CSV file before submitting.');
      return;
    }

    // Client-side file-size guard MUST run before the inFlight flag is set.
    var MAX_MB    = 5;
    var MAX_BYTES = MAX_MB * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      track('upload_failed', { reason: 'file_too_large_client' });
      App.showError('File is too large. Maximum allowed size is ' + MAX_MB + ' MB.');
      return;
    }

    // Prevent double-submit
    if (state.inFlight) return;
    state.inFlight = true;
    App.setLoading(true);
    track('upload_started');

    var formData = new FormData();
    formData.append('csvfile', file);

    try {
      var response = await fetch('/upload', { method: 'POST', body: formData });

      var data;
      try {
        data = await response.json();
      } catch (_) {
        throw new Error('The server returned an unexpected response. Please try again.');
      }

      if (!response.ok) {
        var errMsg = (data && data.error) ? data.error : '';
        track('upload_failed', { reason: App.uploadErrorCategory(response.status, errMsg), http_status: response.status });
        App.showError(errMsg || 'Server error (' + response.status + ').');
        return;
      }

      App.resultsRenderer.renderAll(data);
      App.historyManager.autoSaveRun(data);

    } catch (err) {
      track('upload_failed', { reason: 'network_error' });
      App.showError(err.message || 'A network error occurred. Please check your connection.');
    } finally {
      state.inFlight = false;
      App.setLoading(false);
    }
  });

  // ── Load sample data ──────────────────────────────────────────────────────
  dom.loadSampleBtn.addEventListener('click', async function () {
    if (state.inFlight) {
      App.showError('An upload is already in progress. Please wait for it to complete.');
      return;
    }
    dom.loadSampleBtn.disabled    = true;
    dom.loadSampleBtn.textContent = 'Loading\u2026';
    App.hideError();

    try {
      var response = await fetch('/sample-data');
      if (!response.ok) throw new Error('Could not load the sample file.');

      var blob = await response.blob();
      var file = new File([blob], 'sample_inventory.csv', { type: 'text/csv' });

      // Programmatically populate the file input
      var dt = new DataTransfer();
      dt.items.add(file);
      dom.fileInput.files = dt.files;

      // Sync the label and submit button state, then auto-submit
      dom.fileInput.dispatchEvent(new Event('change'));
      track('sample_loaded');
      dom.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    } catch (err) {
      App.showError(err.message || 'Failed to load sample data.');
    } finally {
      dom.loadSampleBtn.disabled    = false;
      dom.loadSampleBtn.textContent = 'Load sample data';
    }
  });

  // ── Sample CSV download link ──────────────────────────────────────────────
  var sampleDownloadLink = document.getElementById('sampleDownloadLink');
  if (sampleDownloadLink) {
    sampleDownloadLink.addEventListener('click', function () {
      track('sample_csv_downloaded');
    });
  }

  // ── Live demo ─────────────────────────────────────────────────────────────
  if (dom.liveDemoBtn) {
    dom.liveDemoBtn.addEventListener('click', async function () {
      if (state.inFlight) {
        App.showError('An upload is already in progress. Please wait for it to complete.');
        return;
      }
      state.inFlight = true;
      dom.liveDemoBtn.disabled    = true;
      dom.liveDemoBtn.textContent = 'Loading\u2026';
      App.hideError();
      App.hideResults();
      if (dom.demoBadge) dom.demoBadge.classList.add('hidden');

      try {
        var response = await fetch('/api/demo-analysis');
        if (!response.ok) throw new Error('Could not load the demo analysis.');

        var data = await response.json();
        if (dom.demoBadge) dom.demoBadge.classList.remove('hidden');
        track('demo_loaded');
        App.resultsRenderer.renderAll(data);
      } catch (err) {
        App.showError(err.message || 'Failed to load demo analysis.');
      } finally {
        state.inFlight = false;
        dom.liveDemoBtn.disabled    = false;
        dom.liveDemoBtn.textContent = '\u25B6 Try Live Demo';
      }
    });
  }
})();
