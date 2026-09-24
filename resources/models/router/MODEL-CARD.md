# Auto Router model artifact (RF-79)

Encrypted, integrity-checked payload the extension routes with. **Development content must never be
packaged**: this directory holds only the model artifact and this card.

| | |
|---|---|
| file | `rf-79-router.enc` |
| sha256 | `6281063308dcedcab121a292ae1e99d6cd27845bdd2fefde3a38e4fadd8b8b21` |
| bytes | 209,849 (plaintext 785,002, gzip 209,821) |
| format | `nonce(12) \|\| AES-256-GCM ciphertext` over `gzip(JSON)` |
| plaintext | `{ format, model: RF-79 trees (400 trees / 26,570 nodes / 79 features), calibration, provenance }` |
| model sha256 | `c8eb09e491d2447f8547953d11124c0bd6adf857885856554b024f67d2637dac` |
| calibration sha256 | `96a3f3c07f28c89c708f29d330c565207f15c835f6bbba0453d69a2137532772` |

## What it predicts

`pDirect = 1 - pChain` from a 400-tree random forest over 79 **structural** features of the staged
diff (file/hunk shape, edit kind, lexical markers, identifier dynamics, cross-file coherence).
Nothing is derived from the repository name, paths outside the diff, candidate messages, or
post-generation telemetry. Training: 3,636 labelled changes / 30 repositories; holdout 678 cases
with ROC-AUC 0.666461 and Direct PR-AUC 0.7169.

**The score is not a probability on new data.** Calibration error is 0.0084 on train out-of-fold
scores but **0.0424 on the holdout** (Platt 0.0360, isotonic 0.0517) — a 5x degradation that is the
reason thresholds below are coverage quantiles rather than "pDirect must exceed 0.7" rules.

## Naming: Direct/Chain vs Fast/Deep

The tables and the model report call the two routes **Direct** (single-shot candidate) and **Chain**
(multi-stage candidate) — that is the vocabulary of the judged data, and it is what `pDirect` and
the training labels refer to. The extension's user-facing names are **Fast** (one generation, taken
when `pDirect` clears the threshold) and **Deep** (the chain workflow otherwise). The mapping is
exactly 1:1; no score changes with the label.

## Thresholds

The threshold is **a coverage knob, not a probability promise**: on the holdout, a coverage target
of the top 10% of OOF scores yields Direct precision 0.882 (118 false Direct per 1000 routed), and
precision floors do not transfer from train OOF to new data. `calibration.productTable` inside the
artifact carries the coverage→threshold mapping; do not invent a threshold of your own (a naive
`pDirect >= 0.5` routes ~50% of traffic at ~70% precision).

The shipped default is **coverage 0.20 → threshold 0.6219035253036144**, where the holdout bought
Direct precision 0.8116 (188 false Direct per 1000 routed).
`routeAutoGeneration` looks that row up in the table by target coverage and fails the load if the row
is missing, so the number here, the number in the table and the number the router applies cannot
drift apart.

## Integrity

Loads through `src/services/router/modelArtifact.ts`, which verifies the GCM tag before parsing.
Any modification — flipping one ciphertext byte, replacing the artifact, corrupting the base64
module — makes decryption fail, and the router then **refuses to route and falls back to the chain
workflow** rather than running a modified model.

**The key ships with the client, so this is obfuscation, not cryptographic protection against a
determined attacker.** It prevents accidental edits and plain-text weights, nothing more.

## Regenerating

```bash
cd commit-agent-benchmark/training_data/router-dataset/v6-pairwise-judge/router
.venv/bin/python scripts/rf_export.py                    # ts/rf-model-rf79.json
.venv/bin/python scripts/export_calibration_ts.py        # ts/calibration-rf-79.json
.venv/bin/python scripts/export_artifact_encrypted.py    # this artifact + the generated module
cd ts && bun run feature79-parity.ts                     # feature/decision parity
```
