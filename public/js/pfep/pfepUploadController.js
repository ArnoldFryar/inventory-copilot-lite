/* pfepUploadController.js — PFEP CSV upload workflow.
 *
 * Handles:
 *   - File selection + drag-and-drop on the dropzone
 *   - Client-side file-size guard (5 MB)
 *   - POST /api/pfep/upload   — validates + scores the CSV (no auth required)
 *   - POST /api/pfep/runs     — saves the run and redirects to the register
 *                                (requires auth + Pro; shows inline result otherwise)
 *
 * Dependencies (loaded before this script via <script> tags):
 *   - auth.js          (window.authModule)
 *   - Icon.js          (window.App.Icon)
 *   - pfepApp.js       (auth wiring, icon hydration)
 */
(function () {
  'use strict';

  var App = window.App = window.App || {};
  App.pfep = App.pfep || {};

  var MAX_BYTES = 5 * 1024 * 1024; // 5 MB

  // ── DOM refs ──────────────────────────────────────────────────────────────
  var form          = document.getElementById('pfepUploadForm');
  var fileInput     = document.getElementById('pfepfile');
  var fileLabelText = document.getElementById('pfepFileLabel');
  var submitBtn     = document.getElementById('pfepSubmitBtn');
  var submitLabel   = document.getElementById('pfepSubmitLabel');
  var errorBanner   = document.getElementById('pfepErrorBanner');
  var warningBanner = document.getElementById('pfepWarningBanner');
  var successPanel  = document.getElementById('pfepSuccessPanel');
  var dropZone      = document.getElementById('pfepDropZone');

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
      var items = warnings.map(function (w) {
        return '<li>' + escHtml(w) + '</li>';
      }).join('');
      warningBanner.innerHTML =
        'Import completed with ' + warnings.length + ' warnings:<ul class="warning-list">' + items + '</ul>';
    }
    show(warningBanner);
  }

  function setLoading(on) {
    if (!submitBtn || !submitLabel) return;
    if (on) {
      submitBtn.classList.add('is-loading');
      submitBtn.classList.remove('is-ready');
      submitLabel.textContent = 'Importing\u2026';
      submitBtn.disabled = true;
    } else {
      submitBtn.classList.remove('is-loading');
      submitLabel.textContent = 'Import PFEP';
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
      if (fileLabelText) fileLabelText.textContent = 'Choose a PFEP CSV file\u2026';
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
      if (!dropZone.contains(e.relatedTarget)) {
        dropZone.classList.remove('is-drag-over');
      }
    });

    dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dropZone.classList.remove('is-drag-over');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files[0]) {
        try {
          var dt = new DataTransfer();
          dt.items.add(files[0]);
          fileInput.files = dt.files;
        } catch (_) {
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
      showError('File is too large (max 5\u202fMB). Split your PFEP into smaller batches and try again.');
      return;
    }

    inFlight = true;
    setLoading(true);
    hide(errorBanner);
    hide(warningBanner);
    hide(successPanel);

    var formData = new FormData();
    formData.append('csvfile', file);

    fetch('/api/pfep/upload', { method: 'POST', body: formData })
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
  function trySaveAndRedirect(uploadData) {
    var token = null;

    function attemptSave() {
      if (!token) {
        showInlineResult(uploadData, 'Sign in to save and revisit this import from your PFEP register.');
        return;
      }

      fetch('/api/pfep/runs', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify({
          file_name:   uploadData.file_name,
          rows:        uploadData.rows        || [],
          alerts:      uploadData.alerts      || [],
          summary:     uploadData.summary     || {},
          meta:        uploadData.meta        || {},
          stats:       uploadData.stats       || {},
          warnings:    uploadData.warnings    || [],
          errors:      uploadData.errors      || [],
          source_type: 'manual',
        }),
      })
        .then(function (saveRes) {
          if (saveRes.status === 403) {
            return saveRes.json().catch(function () { return {}; }).then(function () {
              showInlineResult(uploadData, 'Upgrade to Pro to save and revisit this import from your register.');
            });
          }
          if (!saveRes.ok) {
            return saveRes.json().catch(function () { return {}; }).then(function (d) {
              showInlineResult(uploadData, (d && d.error) ? d.error : 'Could not save this import. Results are shown below.');
            });
          }
          return saveRes.json().then(function (saved) {
            if (saved && saved.id) {
              window.location.href = '/pfep';
            } else {
              showInlineResult(uploadData, null);
            }
          });
        })
        .catch(function () {
          showInlineResult(uploadData, 'Could not save this import. Results are shown below.');
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
  function showInlineResult(data, footerMsg) {
    if (!successPanel) return;

    var summary     = data.summary   || {};
    var alerts      = data.alerts    || [];
    var totalParts  = fmt(summary.total_parts  || (Array.isArray(data.rows) ? data.rows.length : 0));
    var alertCount  = fmt(summary.alert_count  || alerts.length);
    var gapCount    = fmt(summary.data_gap_count  || 0);
    var aCount      = fmt(summary.a_class_count   || 0);

    var html =
      '<div class="pco-upload-result-header">' +
        '<span data-icon="check" data-icon-size="15" data-icon-class="pco-upload-result-icon" aria-hidden="true"></span>' +
        '<strong>Import complete</strong>' +
        '<span class="pco-upload-result-file">' + escHtml(data.file_name || '') + '</span>' +
      '</div>' +
      '<div class="pco-upload-result-stats">' +
        statCell(totalParts, 'parts imported') +
        statCell(alertCount, 'data quality alerts') +
        statCell(gapCount,   'data gaps') +
        statCell(aCount,     'A-class parts') +
      '</div>';

    if (footerMsg) {
      html += '<p class="pco-upload-result-note">' + escHtml(footerMsg) + '</p>';
    }

    html +=
      '<div class="pco-upload-result-actions">' +
        '<a href="/pfep" class="pco-empty-cta">Back to PFEP Register</a>' +
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
    if (n == null || isNaN(n)) return '\u2014';
    return Number(n).toLocaleString('en-US');
  }

  App.pfep.uploadController = { resetUploadState: function () {
    if (fileLabelText) fileLabelText.textContent = 'Choose a PFEP CSV file\u2026';
    if (submitBtn) { submitBtn.disabled = true; submitBtn.classList.remove('is-ready', 'is-loading'); }
    hide(errorBanner);
    hide(warningBanner);
    hide(successPanel);
  }};
})();
