/* comparisonRenderer.js — run-to-run comparison panel rendering. */
(function () {
  'use strict';

  var App   = window.App;
  var dom   = App.dom;
  var track = App.track;

  /**
   * Fetches comparison data for a given run ID and renders the panel.
   * Silent on failure — the comparison panel simply stays hidden.
   */
  async function fetchAndRenderComparison(runId, token) {
    try {
      if (!token) token = await window.authModule.getToken();
      if (!token) return;
      var res = await fetch('/api/runs/' + encodeURIComponent(runId) + '/compare', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!res.ok) return;
      var comparison = await res.json();
      renderComparison(comparison);
    } catch (_) {
      // Silent — comparison is supplementary.
    }
  }

  /**
   * Renders the "Changes Since Last Upload" panel from comparison data.
   * Hides the panel if hasPrior is false (first run).
   */
  function renderComparison(cmp) {
    if (!dom.comparisonSection) return;
    if (!cmp || !cmp.hasPrior) {
      dom.comparisonSection.classList.add('hidden');
      return;
    }

    // Title / prior run context
    if (dom.comparisonPrior && cmp.priorFileName) {
      var d = cmp.priorUploadedAt
        ? new Date(cmp.priorUploadedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : '';
      dom.comparisonPrior.textContent = 'vs. ' + cmp.priorFileName + (d ? ' \u00b7 ' + d : '');
    }

    // Leadership sentence
    if (dom.comparisonSentence) {
      dom.comparisonSentence.textContent = cmp.leadershipSentence || '';
    }

    // Summary grid: compact stat cards for key change categories
    if (dom.comparisonGrid) {
      while (dom.comparisonGrid.firstChild) dom.comparisonGrid.removeChild(dom.comparisonGrid.firstChild);

      var cards = [
        { label: 'New Urgent',      value: cmp.newUrgent?.length      || 0, cls: 'cmp-urgent' },
        { label: 'Resolved Urgent', value: cmp.resolvedUrgent?.length || 0, cls: 'cmp-resolved' },
        { label: 'Worsened',        value: cmp.worsened?.length       || 0, cls: 'cmp-worsened' },
        { label: 'Improved',        value: cmp.improved?.length       || 0, cls: 'cmp-improved' },
        { label: 'New Parts',       value: cmp.added?.length          || 0, cls: 'cmp-added' },
        { label: 'Removed',         value: cmp.removed?.length        || 0, cls: 'cmp-removed' }
      ];

      cards.forEach(function (c) {
        var div = document.createElement('div');
        div.className = 'cmp-card ' + c.cls;
        var valEl = document.createElement('span');
        valEl.className = 'cmp-card-value';
        valEl.textContent = c.value;
        var lblEl = document.createElement('span');
        lblEl.className = 'cmp-card-label';
        lblEl.textContent = c.label;
        div.appendChild(valEl);
        div.appendChild(lblEl);
        dom.comparisonGrid.appendChild(div);
      });

      // Status deltas row
      if (cmp.statusDeltas) {
        var deltaRow = document.createElement('div');
        deltaRow.className = 'cmp-deltas';
        var buckets = [
          ['Urgent Stockout Risk', 'Urgent'],
          ['Stockout Risk',        'At Risk'],
          ['Potential Dead Stock', 'Dead Stock'],
          ['Excess Inventory',     'Excess'],
          ['Healthy',              'Healthy']
        ];
        buckets.forEach(function (b) {
          var delta = cmp.statusDeltas[b[0]] || 0;
          if (delta === 0) return;
          var chip = document.createElement('span');
          chip.className = 'cmp-delta-chip ' + (delta > 0 ? 'cmp-delta-up' : 'cmp-delta-down');
          chip.textContent = b[1] + ' ' + (delta > 0 ? '+' : '') + delta;
          deltaRow.appendChild(chip);
        });
        if (deltaRow.children.length > 0) {
          dom.comparisonGrid.appendChild(deltaRow);
        }
      }
    }

    // Expandable detail list of changed items
    if (dom.comparisonDetails && dom.comparisonDetailsBody) {
      while (dom.comparisonDetailsBody.firstChild) dom.comparisonDetailsBody.removeChild(dom.comparisonDetailsBody.firstChild);

      var sections = [
        { title: 'New Urgent Items',      items: cmp.newUrgent,      showPrev: true },
        { title: 'Resolved Urgent Items', items: cmp.resolvedUrgent, showPrev: true },
        { title: 'Worsened',              items: cmp.worsened,       showPrev: true },
        { title: 'Improved',              items: cmp.improved,       showPrev: true },
        { title: 'New Parts',             items: cmp.added,          showPrev: false },
        { title: 'Removed Parts',         items: cmp.removed,        showPrev: false }
      ];

      var hasItems = false;
      sections.forEach(function (sec) {
        if (!sec.items || sec.items.length === 0) return;
        hasItems = true;

        var h4 = document.createElement('h4');
        h4.className = 'cmp-detail-heading';
        h4.textContent = sec.title + ' (' + sec.items.length + ')';
        dom.comparisonDetailsBody.appendChild(h4);

        var ul = document.createElement('ul');
        ul.className = 'cmp-detail-list';
        sec.items.forEach(function (item) {
          var li = document.createElement('li');
          var pn = document.createElement('strong');
          pn.textContent = item.part_number;
          li.appendChild(pn);

          if (sec.showPrev && item.prev_status) {
            var arrow = document.createTextNode(' ' + item.prev_status + ' \u2192 ' + item.status);
            li.appendChild(arrow);
          } else {
            var st = document.createTextNode(' \u2014 ' + item.status);
            li.appendChild(st);
          }

          if (item.coverage !== null && item.coverage !== undefined) {
            var cov = document.createTextNode(' \u00b7 ' + item.coverage + ' days coverage');
            li.appendChild(cov);
          }
          ul.appendChild(li);
        });
        dom.comparisonDetailsBody.appendChild(ul);
      });

      if (hasItems) {
        dom.comparisonDetails.classList.remove('hidden');
      } else {
        dom.comparisonDetails.classList.add('hidden');
      }
    }

    dom.comparisonSection.classList.remove('hidden');
    track('comparison_shown', {
      new_urgent: cmp.newUrgent?.length || 0,
      worsened: cmp.worsened?.length || 0,
      improved: cmp.improved?.length || 0
    });
  }

  App.comparisonRenderer = {
    fetchAndRenderComparison: fetchAndRenderComparison,
    renderComparison:         renderComparison,
  };
})();
