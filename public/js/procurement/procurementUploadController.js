/* procurementUploadController.js — PO CSV upload workflow for Procurement Copilot.
 *
 * Handles:
 *   - File selection + drag-and-drop on the dropzone
 *   - Client-side file-size guard (5 MB)
 *   - POST /api/procurement/upload  — validates + scores the CSV (no auth required)
 *   - POST /api/procurement/runs    — saves the run and redirects to the detail page
 *                                     (requires auth + Pro; shows inline result otherwise)
 *
 * Dependencies (loaded before this script via <script> tags):
 *   - auth.js          (window.authModule)
 *   - Icon.js          (window.App.Icon)
 *   - procurementApp.js (auth wiring, icon hydration)
 */
(function () {
  'use strict';

  var App = window.App = window.App || {};
  App.procurement = App.procurement || {};

  var MAX_BYTES = 5 * 1024 * 1024; // 5 MB

  // ── DOM refs ─────────────────────────────────────────────────────────────
  var form          = document.getElementById('poUploadForm');
  var fileInput     = document.getElementById('pofile');
  var fileLabelText = document.getElementById('poFileLabel');
  var submitBtn     = document.getElementById('poSubmitBtn');
  var submitLabel   = document.getElementById('poSubmitLabel');
  var errorBanner   = document.getElementById('poErrorBanner');
  var warningBanner = document.getElementById('poWarningBanner');
  var successPanel  = document.getElementById('poSuccessPanel');
  var dropZone      = document.getElementById('poDropZone');

  // Guard: only run on the upload page
  if (!form || !fileInput) return;

  var inFlight = false;

  // ── Utility helpers ───────────────────────────────────────────────────────
  function escHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }

  function showError(msg) {
    hide(warningBanner);
    hide(successPanel);
    if (!errorBanner) return;
    errorBanner.textContent = msg;
    show(errorBanner);
    errorBanner.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function showWarnings(warnings) {
    if (!warningBanner || !Array.isArray(warnings) || warnings.length === 0) return;
    if (warnings.length === 1) {
      warningBanner.textContent = warnings[0];
    } else {
      // Safe: build HTML from escaped strings only
      var items = warnings.map(function (w) {
        return '<li>' + escHtml(w) + '</li>';
      }).join('');
      warningBanner.innerHTML =
        'Analysis completed with ' + warnings.length + ' warnings:<ul class="warning-list">' + items + '</ul>';
    }
    show(warningBanner);
  }

  function setLoading(on) {
    if (!submitBtn || !submitLabel) return;
    if (on) {
      submitBtn.classList.add('is-loading');
      submitBtn.classList.remove('is-ready');
      submitLabel.textContent = 'Analysing\u2026';
      submitBtn.disabled = true;
    } else {
      submitBtn.classList.remove('is-loading');
      submitLabel.textContent = 'Analyse POs';
      // Re-enabled only if a file is still selected
      submitBtn.disabled = !fileInput.files[0];
      if (fileInput.files[0]) submitBtn.classList.add('is-ready');
    }
  }

  function hydrateIcons() {
    if (App.Icon && App.Icon.hydrateAll) App.Icon.hydrateAll();
  }

  // ── File selection ────────────────────────────────────────────────────────
  fileInput.addEventListener('change', function () {
    var file = fileInput.files[0];
    hide(errorBanner);
    hide(successPanel);
    if (file) {
      if (fileLabelText) fileLabelText.textContent = file.name;
      submitBtn.disabled = false;
      submitBtn.classList.add('is-ready');
    } else {
      if (fileLabelText) fileLabelText.textContent = 'Choose a PO CSV file\u2026';
      submitBtn.disabled = true;
      submitBtn.classList.remove('is-ready');
    }
  });

  // ── Drag-and-drop ─────────────────────────────────────────────────────────
  if (dropZone) {
    dropZone.addEventListener('dragover', function (e) {
      e.preventDefault();
      dropZone.classList.add('is-drag-over');
    });

    dropZone.addEventListener('dragleave', function (e) {
      // Only clear the state when actually leaving the zone, not entering a child element
      if (!dropZone.contains(e.relatedTarget)) {
        dropZone.classList.remove('is-drag-over');
      }
    });

    dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dropZone.classList.remove('is-drag-over');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files[0]) {
        // Programmatically set the file input via DataTransfer so the change event fires correctly
        try {
          var dt = new DataTransfer();
          dt.items.add(files[0]);
          fileInput.files = dt.files;
        } catch (_) {
          // DataTransfer not supported (unlikely in modern browsers) — skip file assignment
          return;
        }
        fileInput.dispatchEvent(new Event('change'));
      }
    });
  }

  // ── Form submit ───────────────────────────────────────────────────────────
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (inFlight) return;

    var file = fileInput.files[0];
    if (!file) {
      showError('Please select a CSV file before submitting.');
      return;
    }
    if (file.size > MAX_BYTES) {
      showError('File is too large (max 5\u202fMB). Narrow your ERP export to a single plant, supplier group, or date range and try again.');
      return;
    }

    inFlight = true;
    setLoading(true);
    hide(errorBanner);
    hide(warningBanner);
    hide(successPanel);

    var formData = new FormData();
    formData.append('csvfile', file);

    fetch('/api/procurement/upload', { method: 'POST', body: formData })
      .then(function (res) {
        var status = res.status;
        return res.json().then(function (data) {
          return { status: status, data: data };
        }).catch(function () {
          return { status: status, data: {} };
        });
      })
      .then(function (result) {
        var status = result.status;
        var data   = result.data;

        // Hard failure — 400, 422, 429, 500
        if (status >= 400) {
          var errMsg;
          if (Array.isArray(data.errors) && data.errors.length > 0) {
            errMsg = data.errors.join(' ');
          } else {
            errMsg = data.error || ('Server error (' + status + '). Please try again.');
          }
          showError(errMsg);
          return;
        }

        // Upload succeeded (200 full success, 207 partial)
        if (Array.isArray(data.warnings) && data.warnings.length > 0) {
          showWarnings(data.warnings);
        }

        return trySaveAndRedirect(data);
      })
      .catch(function (err) {
        showError((err && err.message) || 'A network error occurred. Please check your connection and try again.');
      })
      .then(function () {
        inFlight = false;
        setLoading(false);
      });
  });

  // ── Save and redirect ─────────────────────────────────────────────────────
  // Attempts POST /api/procurement/runs with the upload payload; on 201 success
  // redirects to the run detail page.  On 403 (not Pro) or auth absence, falls
  // back to the inline result panel.
  function trySaveAndRedirect(uploadData) {
    var token = null;

    function attemptSave() {
      if (!token) {
        // Not signed in — show inline result with sign-in prompt
        showInlineResult(uploadData, 'Sign in to save and revisit this analysis from your Procurement dashboard.');
        return;
      }

      fetch('/api/procurement/runs', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify({
          file_name:        uploadData.file_name,
          lines:            uploadData.lines            || [],
          supplierRollups:  uploadData.supplierRollups  || [],
          insights:         uploadData.insights         || [],
          actionCandidates: uploadData.actionCandidates || [],
          summary:          uploadData.summary          || {},
          meta:             uploadData.meta             || {},
          stats:            uploadData.stats            || {},
          warnings:         uploadData.warnings         || [],
          errors:           uploadData.errors           || [],
          source_type:      'manual',
        }),
      })
        .then(function (saveRes) {
          if (saveRes.status === 403) {
            return saveRes.json().catch(function () { return {}; }).then(function () {
              showInlineResult(uploadData, 'Upgrade to Pro to save and revisit this analysis from your dashboard.');
            });
          }
          if (!saveRes.ok) {
            return saveRes.json().catch(function () { return {}; }).then(function (d) {
              showInlineResult(uploadData, (d && d.error) ? d.error : 'Could not save this run. Results are shown below.');
            });
          }
          return saveRes.json().then(function (saved) {
            if (saved && saved.id) {
              window.location.href = '/procurement/runs/' + encodeURIComponent(saved.id);
            } else {
              showInlineResult(uploadData, null);
            }
          });
        })
        .catch(function () {
          // Save failed due to network — still show results inline
          showInlineResult(uploadData, 'Could not save this run. Results are shown below.');
        });
    }

    if (!window.authModule) {
      attemptSave();
      return;
    }

    window.authModule.init()
      .then(function () {
        if (!window.authModule.isConfigured()) {
          attemptSave();
          return;
        }
        return window.authModule.getSession().then(function (session) {
          if (session && session.access_token) token = session.access_token;
          attemptSave();
        });
      })
      .catch(function () {
        attemptSave();
      });
  }

  // ── Inline result panel ───────────────────────────────────────────────────
  // Shown when the run cannot be saved (not Pro, not signed in, or save error).
  // Displays key summary stats so buyers still get immediate value.
  function showInlineResult(data, footerMsg) {
    if (!successPanel) return;

    var summary    = data.summary || {};
    var currency   = summary.currency || 'USD';
    var totalLines = fmt(summary.total_lines || (Array.isArray(data.lines) ? data.lines.length : 0));
    var flagged    = fmt(summary.flagged_lines        || 0);
    var pastDue    = fmt(summary.past_due_lines       || 0);
    var highRisk   = fmt(summary.high_risk_suppliers  || 0);
    var exposure   = fmtCurrency(summary.dollar_exposure_at_risk, currency);

    var html =
      '<div class="pco-upload-result-header">' +
        '<span data-icon="check" data-icon-size="15" data-icon-class="pco-upload-result-icon" aria-hidden="true"></span>' +
        '<strong>Analysis complete</strong>' +
        '<span class="pco-upload-result-file">' + escHtml(data.file_name || '') + '</span>' +
      '</div>' +
      '<div class="pco-upload-result-stats">' +
        statCell(totalLines, 'lines analysed') +
        statCell(flagged,    'flagged') +
        statCell(pastDue,    'past due') +
        statCell(highRisk,   'high-risk suppliers') +
        (summary.dollar_exposure_at_risk ? statCell(exposure, 'at-risk exposure') : '') +
      '</div>';

    if (footerMsg) {
      html += '<p class="pco-upload-result-note">' + escHtml(footerMsg) + '</p>';
    }

    html +=
      '<div class="pco-upload-result-actions">' +
        '<a href="/procurement" class="pco-empty-cta">Back to Procurement</a>' +
      '</div>';

    successPanel.innerHTML = html;
    show(successPanel);
    hydrateIcons();
  }

  function statCell(value, label) {
    return (
      '<span class="pco-upload-stat">' +
        '<strong>' + escHtml(String(value)) + '</strong>' +
        escHtml(label) +
      '</span>'
    );
  }

  function fmt(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US');
  }

  function fmtCurrency(value, currency) {
    if (value == null || isNaN(value)) return '—';
    var cur = (currency || 'USD').toUpperCase();
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: cur, maximumFractionDigits: 0,
      }).format(value);
    } catch (_) {
      return cur + '\u00a0' + Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 });
    }
  }

  App.procurement.uploadController = { resetUploadState: function () {
    if (fileLabelText) fileLabelText.textContent = 'Choose a PO CSV file\u2026';
    if (submitBtn) { submitBtn.disabled = true; submitBtn.classList.remove('is-ready', 'is-loading'); }
    hide(errorBanner);
    hide(warningBanner);
    hide(successPanel);
  }};
})();
