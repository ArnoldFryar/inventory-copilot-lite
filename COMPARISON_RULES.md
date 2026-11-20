# Inventory comparison rules

Pro can compare a saved inventory analysis to an earlier, complete, compatible run belonging to the same account. The default selects the most recent compatible match among the last 50 prior records. The user can also choose an earlier saved run in History. The baseline name and date appear with the comparison.

A compatible pair uses the same inventory module, source type, rules, worksheet, and coverage basis. Coverage basis records site scope, unit scope, usage period, and on-hand versus available stock. Both runs require ranked inputs and complete saved rows. A legacy preview or an incompatible baseline returns a reason in place of a comparison.

Each row matches an exact part identifier with its normalized site and unit. Part identifiers are case-sensitive and retain leading zeros. Rows missing identifiers are excluded. Multiple rows with the same part, site, and unit make that comparison ambiguous.

| Result | Rule |
| --- | --- |
| New urgent | The current row is urgent and is new to the file or worsened from a lower risk. |
| Resolved urgent | A previously urgent row is present and now has a scored status outside both shortage risk groups. |
| Worsened or improved | A matched row moves between scored statuses. |
| New in file or no longer in file | A row appears in only one run. Missing previously urgent rows count here. |
| Could not verify | A part, site, and unit is duplicated, or a matched row changes to or from an unscored status. |
| Unchanged | The status stays the same. |

Risk order runs from Urgent Stockout Risk, Stockout Risk, Potential Dead Stock, Excess Inventory, to Healthy. Invalid and No Usage Data have no risk rank. Differences in status counts cover all saved rows and can include additions and omissions. Review the baseline scope before interpreting them.

`GET /api/runs/:id/compare` accepts an optional `baseline` run ID. It checks ownership, chronology, completeness, and compatibility before comparing. This is a pairwise review of snapshot inputs.
