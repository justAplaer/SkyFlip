# Test report

- Frontend build: passed (`npm run build`).
- Frontend tests: 95 passed (`npm test`). These include Copy 3's time math tests, not an interactive browser test.
- Backend: 13 non-HTTP track, speed and archive security tests passed; 3 HTTP test-client cases were deselected after the local socket restriction caused the test client to hang. ERFA reported future-date/time and distance warnings.
- Direct backend function calls calculated five distinct target speeds and generated a 10-point WISE track.
- Offline controlled batch/report check: simulated cutout and full-frame batches each produced 10 ordered records, one intentionally failed cutout was skipped, and linked reports were written and re-read. Full-frame pyramid generation was mocked.
- Vite reported ready, but a local HTTP request failed with a socket access restriction. Uvicorn could not complete local event-loop/socket startup in this environment. The frontend-to-backend connection, welcome navigation, live IRSA retrieval, image playback, time animation, frame tick switching, marker accuracy, highlighting, drag and zoom interactions, responsive layout, browser console/network errors, and report submission over HTTP remain untested here.
- Earlier IRSA connection attempt failed DNS resolution. No live NASA data was verified.
