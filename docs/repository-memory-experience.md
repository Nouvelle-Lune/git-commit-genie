# Repository Memory investigation experience

Repository Memory stores historical investigation experience, not current repository facts. A handbook entry describes an applicable situation, optional investigation steps, and optional lessons with explicit limitations. Every step and lesson cites observations from at least two independent Git snapshots.

A recommended step links a recorded question to a successful source observation and a retained final claim that used that source. This establishes a recorded association, not semantic correctness or an optimal investigation strategy. Lessons can retain local failures and empty results without pretending that source code was returned. Tool completion, analysis completion, and claim usage never imply a successful repair or passing tests.

Consolidation selects a seed investigation and at most 19 related investigations using paths, symbols and BM25. Inputs retain questions, tool reasons and arguments, order, results, claims and excerpts. Only complete episodes fit into the input budget. Existing experiences are updated through explicit handles and retain their identity; a no-findings response does not delete previous experience. Failed entries cannot replace existing history.

Search ranks handbook content directly before loading its supporting episodes. Explicit model searches query the store again, beyond the initial candidate set. Every recalled entry carries a current-snapshot availability assessment before planning: each target is `available` only when its saved blob is unchanged, `needs_revalidation` when the path still exists with different content, and `unavailable` when the current after-tree has no readable file at that path. A lesson without a target is `historical_only`. Location staleness never proves that the historical experience is false.

Later investigations can retire an experience only with successful after-tree counterevidence from at least two independent snapshots. Every counterexample must retain its investigation question and a non-omit claim that cites the selected source. The original entry remains stored with the retirement reason and optional replacement link. Retirement is contextual: it is `retired` only when all recorded counterevidence from at least one supporting investigation still matches the current snapshot; otherwise it is `retirement_unmatched`. Raw episode leads already represented by any handbook entry or retirement are suppressed so retired advice cannot reappear through the unconsolidated path.

Published M* entries and their sources remain immutable within an investigation. Reading memory sources validates them against the current Git snapshot and registers only current source material as E* evidence. Historical failures do not become E* evidence.

The “Recheck organized evidence” report separates previews of existing history from entries actually published by the current recheck. Each step and lesson exposes its records, independent snapshot count, recorded results and limitations. No-findings and failed rechecks never display old entries as new results.

The experience format intentionally replaces the unreleased old handbook and episode formats. The current manifest protocol is version 3. Explicitly clear repository memory before using it; there is no data migration or automatic startup reset. Clearing preserves the existing accounting boundary and does not delete unrelated logs.

Real Chain replay and Memory on/off quality or cost evaluation are deferred. Structural checks and unit tests do not establish quality improvement or savings.
