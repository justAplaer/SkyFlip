# UI merge report

## Integration

The React/TypeScript interface, styling, navigation, frame strip and onboarding controls come from SkyFlip-cyan-target-frontend. The FastAPI backend, IRSA adapters, persistent batch and report services, database initialization, archive explorer and scientific processing come from SkyFlip_Merged. The interface now calls the persistent batch API and attaches saved batch IDs and modes to reports. A welcome screen opens the viewer. Full-frame pan is the default pointer tool; box zoom and selection remain separate. The report editor uses native image dimensions and a preview generated from cached full-frame pixels.

API change: added GET `/api/frame/{obs_id}/{detector}/preview?subtract_zodi=false`. No database schema changes in this integration. The previous backend endpoints remain present. See README for ports and setup.

## Checks performed

- `npm run build`: passed after integration.
- `npm test`: 87 existing frontend tests passed; these tests do not cover all new integration features.
- Backend `test_frame_pyramid.py` and `test_observations_validate.py`: 20 passed.
- `scripts/check_merged_offline.py`: direct service checks with controlled data produced 10 ordered images for both modes, skipped a simulated failed image, reloaded batch metadata and saved a batch-linked report in each mode. Full-frame downloads and actual pyramid construction were mocked for this check.
- `scripts/check_preview_offline.py`: generated a PNG preview from a synthetic cached full-frame pyramid.
- Vite reported ready on port 18766, but an HTTP request to that local port failed with a socket access restriction. Uvicorn stalled while opening its event-loop socket in the same restricted environment. HTTP API, actual browser interaction, welcome navigation, playback, dragging/highlight alignment, browser console/network errors, and responsive layouts could not be verified here.
- An attempt to contact IRSA failed because its hostname could not resolve. Live data retrieval remains unverified. Original projects were only read; all implementation was in this new folder.

## Limitations

This is a draft pending an end-to-end run on a machine with local network access and internet. In particular, verify full-frame report preview alignment with the viewer, zoom and pan; the synthetic PNG check alone does not prove visual alignment. Fallback/demo images and external archive availability must be tested separately. Saved images depend on the cache being retained. Existing batch time and candidate limits can produce partial batches. This report does not claim the user-facing controls or external data flow have been fully verified.

## Interface polish

Mouse-wheel zoom over either image viewer uses non-passive event handling so the browser does not also zoom or scroll the page. The welcome screen uses NASA/JPL-Caltech's SPHEREx artist's concept via NASA's website; internet access is required for that background, and a dark fallback remains if it is unavailable. The search guide gives decimal-degree and sexagesimal examples, and sexagesimal component ranges are validated. The archive FITS fetch path rejects untrusted hosts, traversal and redirects; this is a targeted hardening change, not a comprehensive security audit.

Verification: frontend build and 88 tests passed; 20 existing backend tests and 2 archive URL/redirect tests passed. Browser interaction, image alignment and real NASA downloads remain unverified in this restricted environment, which cannot connect to local server sockets or resolve IRSA.
