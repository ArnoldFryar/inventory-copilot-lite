'use strict';

// ---------------------------------------------------------------------------
// server/lib/procurement/types.js — Procurement Copilot data contracts.
//
// This file is documentation-as-code: no runtime logic, no exports beyond
// the shape constants and validator exported at the bottom.  Every shape is
// documented with the same inline-comment style used in analyzer.js, so
// there is one consistent place to look up field semantics across both
// modules.
//
// Naming conventions (mirrors the inventory module):
//   PO line     → the atomic unit, one CSV row, one purchase-order line item
//   Supplier rollup → aggregated view per vendor across all lines in a run
//   Run summary → top-level counts for a procurement analysis run
//   Insight     → a single actionable finding derived from the run
//   Action item → a concrete, human-assigned task derived from an insight
//
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// VALID_DELIVERY_STATUSES
// Enumerated statuses for PO line delivery performance.  Mirrors the
// STATUS_RISK taxonomy in comparator.js — a closed set avoids typo-driven
// display bugs in the renderer.
//
//   on_time       — delivered within the agreed window
//   early         — arrived before the requested date (may cause early receipt charges)
//   late          — arrived after the agreed date
//   partial       — line is only partially fulfilled by supplier
//   overdue       — past due date with no delivery confirmed
//   cancelled     — line was cancelled by buyer or supplier
//   pending       — PO issued but delivery date not yet reached
// ---------------------------------------------------------------------------
const VALID_DELIVERY_STATUSES = new Set([
  'on_time', 'early', 'late', 'partial', 'overdue', 'cancelled', 'pending',
]);

// ---------------------------------------------------------------------------
// VALID_RISK_FLAGS
// Categorical risk signals that can be attached to an insight or a supplier
// rollup.  Kept as a set so validation is O(1) and the list is auditable.
//
//   single_source         — only one supplier provides this item (no backup)
//   concentration_risk    — one supplier accounts for an outsize spend share
//   delivery_variance     — supplier routinely delivers outside the agreed window
//   price_variance        — price paid differs significantly from contract price
//   consolidation_opportunity — multiple small POs to same supplier could be merged
//   excess_order          — ordered quantity exceeds calculated demand requirement
// ---------------------------------------------------------------------------
const VALID_RISK_FLAGS = new Set([
  'single_source',
  'concentration_risk',
  'delivery_variance',
  'price_variance',
  'consolidation_opportunity',
  'excess_order',
]);

// ---------------------------------------------------------------------------
// VALID_INSIGHT_CATEGORIES
// Top-level grouping for a ProcurementInsight.  Matches the three feature
// cards on procurement.html so the renderer can map category → card.
// ---------------------------------------------------------------------------
const VALID_INSIGHT_CATEGORIES = new Set([
  'spend_analysis',
  'supplier_risk',
  'po_consolidation',
]);

// ---------------------------------------------------------------------------
// VALID_ACTION_STATUSES
// Lifecycle states for a ProcurementActionItem.
// ---------------------------------------------------------------------------
const VALID_ACTION_STATUSES = new Set([
  'open', 'in_progress', 'resolved', 'dismissed',
]);

// ===========================================================================
// Shape definitions (JSDoc @typedef-style comment blocks)
// ===========================================================================

// ---------------------------------------------------------------------------
// POLine
//
// One parsed CSV row from a purchase-order export.  Maps to a single line
// item on a PO.  All monetary values are stored as plain numbers (the
// currency is captured at the run level in ProcurementRunSummary.currency).
//
// Required fields (equivalent to inventory's part_number / on_hand):
//   po_number, supplier, line_amount
//
// Optional fields are null when absent or non-parsable, matching the
// treatment of on_hand / daily_usage in RowResult.
//
// {
//   po_number         : string,          // PO identifier (e.g. "PO-2024-00143")
//   line_number       : string | null,   // Line within the PO ("1", "10", etc.)
//   supplier          : string,          // Supplier / vendor name
//   item_code         : string | null,   // Buyer's item/part code (maps to part_number in inventory)
//   item_description  : string | null,   // Free-text description
//   quantity_ordered  : number | null,   // Units ordered
//   quantity_received : number | null,   // Units received to date (null if not tracked)
//   unit_price        : number | null,   // Price per unit (same currency as line_amount)
//   line_amount       : number,          // Total line value = quantity × unit_price
//   order_date        : string | null,   // ISO 8601 date the PO was placed
//   requested_date    : string | null,   // Buyer's requested delivery date
//   confirmed_date    : string | null,   // Supplier's confirmed delivery date
//   actual_date       : string | null,   // Actual delivery date (null if not yet received)
//   delivery_status   : string,          // One of VALID_DELIVERY_STATUSES
//   days_variance     : number | null,   // actual_date - confirmed_date in days; negative = early
//   category          : string | null,   // Spend category / commodity code
//   notes             : string | null,   // Free-text notes from ERP export
// }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SupplierRollup
//
// Aggregated view of all PO lines for a single supplier within a run.
// Produced by the (future) procurement analyser, one entry per unique
// supplier value in the uploaded data.
//
// The risk_flags array captures zero or more entries from VALID_RISK_FLAGS.
// An empty array means no automated risk flags were raised.
//
// {
//   supplier           : string,       // Exact supplier string from the CSV
//   line_count         : number,       // Total PO lines for this supplier
//   po_count           : number,       // Distinct PO numbers (po_number set size)
//   total_spend        : number,       // Sum of line_amount across all lines
//   spend_share_pct    : number,       // Percentage of run's total spend (0-100)
//   on_time_rate_pct   : number | null, // % of receivable lines delivered on time;
//                                       // null when no actual_date data present
//   avg_days_variance  : number | null, // Mean days_variance for received lines
//   item_count         : number,       // Distinct item_code values (null-excluded)
//   risk_flags         : string[],     // Subset of VALID_RISK_FLAGS
//   severity           : 'High' | 'Medium' | 'Low',  // Highest severity across flags
// }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ProcurementRunSummary
//
// Top-level counts for a completed procurement analysis run.  Analogous to
// the `summary` object returned by analyzeRows() in the inventory module.
//
// Stored as summary_json in the analysis_runs table (module_key = 'procurement').
//
// {
//   total_lines          : number,  // Total POLine rows parsed from the CSV
//   total_po_count       : number,  // Distinct PO numbers
//   supplier_count       : number,  // Distinct supplier values
//   total_spend          : number,  // Sum of all line_amount values
//   currency             : string,  // ISO 4217 code inferred/set at upload (e.g. "USD")
//   invalid_lines        : number,  // Lines that could not be parsed (missing required fields)
//   flagged_lines        : number,  // Lines with at least one risk flag
//   high_risk_suppliers  : number,  // SupplierRollups with severity === 'High'
//   insights_count       : number,  // Total ProcurementInsights generated
//   consolidation_savings_estimate : number | null,  // Estimated $ saving if consolidation
//                                   // opportunities are acted on; null when not computable
// }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ProcurementInsight
//
// A single actionable finding produced by the procurement analysis engine.
// Analogous to a RowResult in that it is the atom of the results array.
//
// Stored in results_json (as an array) in the analysis_runs table
// (module_key = 'procurement').
//
// {
//   id               : string,         // Stable deterministic key: "{category}:{detail_key}"
//   category         : string,         // One of VALID_INSIGHT_CATEGORIES
//   severity         : 'High' | 'Medium' | 'Low',
//   title            : string,         // Short headline (≤ 80 chars)
//   description      : string,         // 1-2 sentence explanation
//   affected_supplier: string | null,  // Supplier name when insight is supplier-scoped
//   affected_items   : string[],       // item_code values affected (empty = run-level insight)
//   metric_value     : number | null,  // The numeric measurement behind the finding
//   metric_label     : string | null,  // Human-readable label for metric_value (e.g. "total spend")
//   risk_flags       : string[],       // Subset of VALID_RISK_FLAGS this insight raises
//   recommended_action: string,        // What to do (mirrors RowResult.recommended_action)
// }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ProcurementActionItem
//
// A concrete task derived from one or more ProcurementInsights.  Stored
// client-side initially (localStorage), persisted to a future
// procurement_actions table when history backend is extended.
//
// {
//   id           : string,         // UUID or client-generated stable key
//   insight_id   : string | null,  // Links back to ProcurementInsight.id if applicable
//   run_id       : string | null,  // analysis_runs.id the action originated from
//   status       : string,         // One of VALID_ACTION_STATUSES
//   assignee     : string | null,  // Free-text name or email
//   due_date     : string | null,  // ISO 8601 date
//   note         : string | null,  // Free-text context added by user
//   created_at   : string,         // ISO 8601 timestamp
//   updated_at   : string,         // ISO 8601 timestamp (= created_at initially)
// }
// ---------------------------------------------------------------------------

// ===========================================================================
// Column alias registry for procurement CSV auto-detection.
//
// Mirrors the ALIASES map in columnMap.js.  Used by the (future)
// procurementColumnMap.js to resolve non-canonical header names from
// common ERP exports (SAP ME21, Oracle iProcurement, Coupa, etc.).
//
// Keys are canonical field names (matching the POLine shape above).
// Values are arrays of accepted alternate header strings (lowercased).
// ===========================================================================
const PROCUREMENT_COLUMN_ALIASES = {
  po_number:          ['purchase order', 'po number', 'po no', 'po #', 'order number', 'po_no', 'ponumber', 'doc number', 'document number'],
  line_number:        ['line', 'line no', 'line no.', 'item line', 'pos', 'line number', 'line_no'],
  supplier:           ['vendor', 'vendor name', 'supplier name', 'creditor', 'sold by', 'source'],
  item_code:          ['part number', 'part no', 'sku', 'material', 'item', 'item number', 'material number', 'product code'],
  item_description:   ['description', 'desc', 'part description', 'item description', 'material description'],
  quantity_ordered:   ['qty ordered', 'qty', 'quantity', 'order qty', 'order quantity', 'po qty'],
  quantity_received:  ['qty received', 'received qty', 'qty rec', 'received', 'goods receipt qty', 'gr qty'],
  unit_price:         ['unit price', 'price', 'net price', 'unit cost', 'price per unit'],
  line_amount:        ['line total', 'line value', 'amount', 'net value', 'extended amount', 'total amount', 'po value', 'line amount'],
  order_date:         ['order date', 'po date', 'creation date', 'document date', 'issue date'],
  requested_date:     ['requested date', 'request date', 'need by date', 'required date', 'need date', 'delivery requested'],
  confirmed_date:     ['confirmed date', 'confirm date', 'promised date', 'supplier confirm date', 'eta'],
  actual_date:        ['actual date', 'delivery date', 'receipt date', 'goods receipt date', 'received date'],
  category:           ['category', 'commodity', 'spend category', 'purchase category', 'gl account desc'],
};

// ---------------------------------------------------------------------------
// Exported constants — runtime-accessible for validation and serialisation.
// The shape definitions above are JSDoc-only (no runtime object needed).
// ---------------------------------------------------------------------------
module.exports = {
  VALID_DELIVERY_STATUSES,
  VALID_RISK_FLAGS,
  VALID_INSIGHT_CATEGORIES,
  VALID_ACTION_STATUSES,
  PROCUREMENT_COLUMN_ALIASES,
};
