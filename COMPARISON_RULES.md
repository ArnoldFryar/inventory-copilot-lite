# Comparison Rules & Assumptions

## Overview

The comparison engine (`comparator.js`) computes a deterministic diff between
two analysis result sets, keyed by **part number** (exact, case-sensitive match).

Comparison runs automatically after every upload for signed-in Pro users, and
is also available when loading a saved run from History.

## Comparison Key

- **`part_number`** is the sole join key between runs.
- Rows with no part number or the sentinel value `(no part number)` are excluded
  from matching — they cannot be reliably linked across runs.
- Duplicate part numbers within a run: only the last occurrence is matched
  (Map insertion order). This is intentional — the analyzer already warns about
  duplicates in the upload response.

## Risk Ordering

Statuses are ranked from highest risk (0) to lowest risk (6):

| Rank | Status                  | Severity |
|------|-------------------------|----------|
| 0    | Urgent Stockout Risk    | High     |
| 1    | Stockout Risk           | Medium   |
| 2    | Potential Dead Stock    | Medium   |
| 3    | No Usage Data           | Low      |
| 4    | Excess Inventory        | Low      |
| 5    | Invalid                 | Low      |
| 6    | Healthy                 | Low      |

A part **worsened** if its risk rank decreased (moved up the table).
A part **improved** if its risk rank increased (moved down the table).

## Change Categories

| Category         | Definition |
|------------------|------------|
| **New Urgent**   | Part is `Urgent Stockout Risk` in the current run AND either did not exist in the prior run or had a different (lower-risk) status. |
| **Resolved Urgent** | Part was `Urgent Stockout Risk` in the prior run AND is either improved, removed, or no longer in the file. |
| **Worsened**     | Part exists in both runs; its current status has a lower risk rank (higher risk) than its prior status. |
| **Improved**     | Part exists in both runs; its current status has a higher risk rank (lower risk) than its prior status. |
| **Added**        | Part exists in the current run but not in the prior run. |
| **Removed**      | Part exists in the prior run but not in the current run. |
| **Unchanged**    | Part exists in both runs with the same status classification. |

## Status Deltas

For each of the seven status buckets, a net delta is computed:

    delta = count_in_current − count_in_prior

Positive delta = more parts in that bucket than before.
Negative delta = fewer parts.

## Leadership Sentence

A single plain-language sentence summarising the diff, suitable for forwarding
to plant or supply chain leadership. Format:

> Since the last upload: 2 new urgent items, 1 previously urgent item resolved,
> 3 items worsened, 5 items improved, 2 new parts.

If nothing changed: "No material changes since the last upload."

## Edge Cases

| Scenario | Behaviour |
|----------|-----------|
| **First run** (no prior) | `hasPrior: false` — comparison panel stays hidden |
| **Part in one run only** | Classified as Added or Removed |
| **Invalid → Invalid** | Unchanged (same risk rank) |
| **No-usage rows** | Compared normally against the risk ordering |
| **Anonymous user** | Cannot save runs → no comparison available |
| **Free plan** | Cannot save runs → no comparison available |

## API

### `GET /api/runs/:id/compare`

Authenticated, Pro plan required. Compares run `:id` against the most recent
run uploaded **before** it (by `uploaded_at` timestamp) for the same user.

Response shape (when a prior run exists):

```json
{
  "hasPrior": true,
  "newUrgent": [...],
  "resolvedUrgent": [...],
  "worsened": [...],
  "improved": [...],
  "added": [...],
  "removed": [...],
  "unchanged": 42,
  "statusDeltas": { "Urgent Stockout Risk": -1, "Healthy": 2, ... },
  "leadershipSentence": "Since the last upload: ...",
  "priorRunId": "uuid",
  "priorUploadedAt": "2026-03-14T...",
  "priorFileName": "inventory_march.csv"
}
```

When no prior run exists: `{ "hasPrior": false }`.

## Intentional Limitations

- **No trend analysis** — comparison is strictly pairwise (current vs. one prior run).
- **No forecasting or ML** — all logic is deterministic rule-based.
- **No cross-user comparison** — runs are scoped to the authenticated user.
- **Part number is the only key** — no fuzzy matching, no description-based matching.
