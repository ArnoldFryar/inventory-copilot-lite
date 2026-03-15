# Saved History — Storage Technical Note

## Current approach: JSON-first

Each saved analysis run is stored as a single row in the `analysis_runs` table (Supabase/PostgreSQL). Two JSONB columns hold the bulk of the data:

| Column | Contents |
|---|---|
| `summary_json` | `{ counts, topPriority, thresholds, columnAliases }` — everything needed to re-render the summary, leadership narrative, and priority panel. ~2–5 KB per run. |
| `results_json` | Full array of `RowResult` objects (one per analyzed part). ~200 bytes × row count. A 1,000-part file ≈ 200 KB; the 50k-row ceiling ≈ 10 MB. |

Scalar metadata (`file_name`, `part_count`, `uploaded_at`, `plan_at_upload`, `source_type`) lives in dedicated columns for filtering and listing without deserializing the JSON.

### Why JSON-first

1. **Speed of implementation** — one INSERT, one SELECT. No join queries, no child-table management.
2. **Fidelity** — the exact data the user saw is stored verbatim, so "Load" always reproduces the same report. No re-analysis needed.
3. **Simplicity** — no ORM, no migration versioning beyond the single `CREATE TABLE`.

### Known trade-offs

- **No per-row queries on results**: you cannot query "all parts where coverage < 5" across saved runs without deserializing `results_json`. This is fine today (the product doesn't offer cross-run search) but would block a comparison/trend feature.
- **Storage cost** — JSONB is larger than normalized relational storage. At pilot scale (< 1,000 users × 50 runs × average 200 KB) the total is ≈ 10 GB, well within Supabase free/pro tier limits.
- **Payload size** — `POST /api/runs` and `GET /api/runs/:id` transfer the full results array. The 10 MB JSON body limit accommodates the largest files. For very large files, consider server-side compression or pagination.

## Future normalization path

When the product needs any of the following, split `results_json` into a child table:

```
analysis_results (
  id           uuid PK,
  run_id       uuid FK → analysis_runs.id,
  part_number  text,
  coverage     numeric,
  status       text,
  severity     text,
  on_hand      numeric,
  daily_usage  numeric,
  lead_time    numeric,
  reason       text,
  action       text
)
```

**Triggers for normalization:**
- Cross-run trend analysis ("show me how coverage for part X changed over time")
- Per-part search across all saved runs
- Storage cost exceeds acceptable threshold
- Need to index specific result fields (status, severity) for dashboard queries

**Migration strategy:**
1. Add the child table alongside the existing JSONB column.
2. Backfill from existing `results_json` with a one-time script.
3. Update `POST /api/runs` to write both the JSONB column (for backward compat) and the child table.
4. Update `GET /api/runs/:id` to read from the child table instead of `results_json`.
5. Once stable, drop `results_json` from new inserts (keep for old rows or migrate fully).

The `summary_json` column can stay as JSONB indefinitely — it's small, and its structure (counts + thresholds + topPriority) doesn't benefit from normalization.
