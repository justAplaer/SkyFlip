# Final integration report

The processing-counter version supplies the welcome screen, viewer, batch and report persistence, progress, archive tools, zoom and pan. Copy 3 supplies the TimeMachinePanel controls and time interpolation, catalog-derived speed card, speed and track calculations, and the expanded proper-motion/parallax table. The current viewer was adapted to display a predicted marker and trail; its timeline is populated with dates from the current frames rather than silently linking to the demo manifest. SPHEREx tick selection requests the associated frame. The track is a prediction, not historical imagery. The speed display uses copy 3's `v = 4.74047 * proper_motion * distance` calculation.

| Target | Proper motion (arcsec/year) | Tangential speed (km/s, approximate) |
| --- | ---: | ---: |
| Barnard's Star | 10.393 | 90.076 |
| Epsilon Indi B | 4.704 | 81.085 |
| WISE 0855 | 8.090 | 85.417 |
| RW Aurigae | 0.0275 | 20.368 |
| R Draconis | 0.0215 | 81.627 |

The displayed whole-number speeds are 90, 81, 85, 20 and 82 km/s respectively. These are sideways speeds based on the cited table, not radial or total spatial speeds. Epsilon Indi B uses system proper motion. The two variable-star tracks are held fixed in the time visualization, while their small catalog proper motions contribute to their speed estimates.

Added endpoints `/api/track` and `/api/motion-speed`; no database migration. Copy 3's Compare All Frames feature was not added: it requires significant changes to the current viewer and was not needed for the two requested features. Copy 3's page design was not substituted for the current interface.

Limitations: The HTTP/browser workflow, visual marker alignment, pan/highlight interaction and live archive were not verified because the environment blocks local sockets and IRSA DNS. The timeline integration does not yet carry Copy 3's share-date URL feature or uncertainty ring/outside-view indicator. Animation rendering and centering may need adjustment after a real browser test. The user must verify these before treating this as a final release. Both source projects were read without intentional changes.

## Sun-relative speed update

The speed card now presents approximate 3D speed relative to the Sun where the catalog includes a sourced radial velocity: total = sqrt(sideways^2 + radial^2). The input proper motions and parallaxes are solar-system-barycentric catalog quantities, and heliocentric or barycentric radial velocities are treated as a close approximation for display, not an exact coordinate transformation. Data come from different epochs. The card separately lists angular motion, distance, sideways and radial components, and cites each source. It does not calculate speed from the currently displayed frames.

Radial inputs: Barnard's Star -110.5 km/s (Nidever et al. 2002 via NASA Exoplanet Archive); RW Aur A +14 km/s (France et al. 2014, approximate variable stellar velocity); R Draconis -132.8 km/s (Wilson 1953 via SIMBAD, quality E, tentative). No verified radial velocity for Epsilon Indi B or WISE 0855 is included; their full 3D Sun-relative speed is displayed as unavailable, while the sideways component is shown separately. Do not substitute the velocity of Epsilon Indi A as a measurement of B.

Verification: frontend production build, 95 frontend tests, and 12 non-HTTP backend speed tests passed. Browser and live IRSA checks remain unverified as described in FINAL_TEST_REPORT.md.
