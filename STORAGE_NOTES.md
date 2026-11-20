# Inventory data and saved runs

| Data | Location and lifetime |
| --- | --- |
| Raw CSV or XLSX | Private temporary directory during parsing. The upload handler unlinks files when processing finishes. Periodic cleanup handles abandoned files older than one hour. |
| Unsaved signed-in Pro analysis | Compressed memory cache in the app process, scoped to the owner and a server-generated analysis ID. Entries expire after 30 minutes, with a 64 MB and 128-entry pool. Restart, eviction, or moving to another process can require reanalysis. |
| Saved inventory run | Supabase `analysis_runs` after the owner chooses **Save run**. The server persists the complete normalized row array, counts, rule version, input basis, and source metadata. The original file is excluded. The owner can reopen and delete the record even after moving to Free. Backups follow the configured provider retention. |
| Remembered column mapping | Account-scoped browser storage on the current device. Only the selected headers, worksheet and calculation options are needed for reuse. |
| AI draft | Selected, normalized row facts and bounded guidance go to the configured provider on request. The server checks the returned actions and composes the draft using facts from the run. Draft history stays on the current browser, scoped to the account. The provider's retention follows the deployment terms. |

History lists up to 50 runs per page without loading their result arrays. Opening a run reads the stored array. Table rendering shows 50 rows per page. Older records that hold only a preview identify the available row count when reopened.

Keep the app on one instance while it uses the process-local snapshot cache. Put the cache behind shared private storage and verify expiry and ownership before scaling across instances. Review database request size and backup retention with the hosting provider before onboarding pilot customers.
