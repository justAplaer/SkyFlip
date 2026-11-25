# Privacy and data — community observations

SkyFlip **Report an observation** collects **unverified community observations**, not discoveries and not personal profiles.

## What we collect by default

- Sky position (RA/Dec), target name if any, and frame metadata you already see in the blink player (epoch IDs, MJD, detector, wavelength, WCS keywords, cutout parameters).
- Your selected frames, pixel + sky highlights, short description (≤ 300 words), and optional quiz answers (object guess, direction, confidence, ease).
- Display settings needed to reproduce the view (stretch, zoom, change-slider state, share URL).
- Coarse browser/OS string and viewport size — **not** a cross-session tracking cookie, **not** a device advertising ID.

## What we do **not** collect by default

- Name, age, precise location, phone number, or accounts.
- Plain-text IP addresses retained with the report (rate limiting may use a **salted hash** with a short TTL, then discard).
- Contact email unless you **opt in** with an explicit consent checkbox.

## Optional contact email

Stored in a **separate table** linked only by `submission_id`. Used only if researchers want a follow-up. You can request deletion with your **receipt ID** and **delete token** (shown once after submit).

## Retention (defaults — configurable)

| Data | Default retention |
| --- | --- |
| Observation report + cutout copies | 24 months, then review/delete |
| Optional contact email | 12 months or until deletion request |
| Rate-limit hashes | ≤ 48 hours |

Exact production retention may differ; operators should set env-based policy and document it here when deploying.

## Deletion

`DELETE /api/observations/{submission_id}?delete_token=…` (or equivalent UI) removes the report, blobs, and any contact row.

## Legal / honesty

Submissions are **community observations, unverified**. SkyFlip never claims your report is a real new object or a Planet X discovery.

## Children

Participants may be under 18. We design the form to avoid collecting identifying information. Do not enter personal information in the description box.
