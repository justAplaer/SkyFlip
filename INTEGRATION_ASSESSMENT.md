# Integration assessment — work in progress

The UI reference and backend project share React, TypeScript and Vite code. The backend project uses FastAPI and SQLite. The reference's main App has a different layout and adds FrameStrip and StartChecklist, but does not include the backend project's persistent batch client. Both contain image playback, report UI and FullFrameStage; the reference stage has separate pan, box and select tools. The backend project additionally contains the Part 1 archive explorer, `/api/archive` integration and persistent `/api/batches` client.

Integration risks: adopting the reference App as-is would lose saved batches and server-validated report linkage; adopting only its CSS would not reproduce its layout. Full-frame dragging already exists in the reference, but report highlights are handled separately and their relationship to panning needs explicit verification. The reference does not contain a standalone welcome page in its source tree; it has onboarding/checklist UI. A welcome flow still needs implementation.

This folder is currently an unmodified functional starting copy of the backend project. No UI integration has been completed and no final tests have been performed in this copy. The original folders are separate.
