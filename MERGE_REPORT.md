# Merge report

## Design

Part 2 supplies the React/TypeScript viewer, playback, full-frame pyramid and cutout retrieval, target presets, fallback demo packs, and FastAPI scientific and observation modules. Part 1 supplies the separate archive explorer, SIA search, Gaia overlays, FITS comparison and All-Sky Cube interface, adapted under `/api/archive`. The existing appearance was largely retained.

New persistent asynchronous batches store requests, image identifiers, metadata, progress, failures and ordered results in SQLite. Batch reports verify coordinates, image mode and selected frame identities against the stored batch. SQLite connections in batch operations are explicitly closed for Windows. Part 2's normal viewer and its cached demo behavior remain separate from new live batch requests. Original input files were not intentionally changed.

## Verification

- Frontend production build succeeded; 87 frontend tests passed in the preceding work session.
- Direct offline checks in `scripts/check_merged_offline.py` produced 10 ordered frames for both modes with simulated archive data. One deliberately failing cutout was skipped and 10 successes persisted. Batch metadata could be loaded again and the SQLite file could be cleaned up after connections closed. Full-frame pyramid construction was simulated in this test.
- 207 recorded source files in both original folders matched their pre-merge SHA-256 hashes. This check covers the files recorded in the manifest, not every dependency or binary.
- The backend HTTP tests did not complete: this execution environment blocked creation of the local socket used by Python's test client. Live NASA retrieval, actual full-frame image rendering, frontend/backend communication, report submission through HTTP, playback, and an end-to-end browser run have not been verified in this session. The result should be treated as a working draft pending those tests on a machine with normal local networking and live archive access.

## Limitations

Batches try at most 40 candidates and have a configurable time budget; a partial result can occur even if further archive images exist. Full-frame batches may take substantial time and disk space. Cutout images depend on the local cache: deleting it breaks stored image links. Jobs interrupted by a server restart are marked partial or failed rather than resumed. Run one backend process per database for this local design. Real archive performance and the scientific usefulness of individual observations depend on availability, coverage, image quality and band differences. Demo packs are not a substitute for verifying live retrieval. The inherited extended analysis features and archive integration still need end-to-end validation.
