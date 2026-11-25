import { useEffect, useState } from "react";
import { readJsonPref, writeJsonPref } from "../lib/panelPrefs";

const KEY = "skyflip.tour.dismissed";

const STEPS = [
  "Pick a demo target (for example WISE 0855).",
  "Press Play to blink SPHEREx visits like a short video.",
  "Watch the circled / yellow marker — movers shift between frames.",
  "Try Box zoom to inspect a small patch, then Fit / Go to target.",
];

export function FirstRunTour({ forceOpen, onClose }: { forceOpen?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (forceOpen) {
      setOpen(true);
      setStep(0);
      return;
    }
    // Demo / embed / automated runs should not trap clicks under the overlay.
    try {
      const p = new URLSearchParams(window.location.search);
      if (p.get("demo") === "1" || p.get("embed") === "1" || p.get("tour") === "0") {
        return;
      }
    } catch {
      /* ignore */
    }
    const dismissed = readJsonPref(KEY, false);
    if (!dismissed) setOpen(true);
  }, [forceOpen]);

  if (!open) return null;

  const dismiss = () => {
    writeJsonPref(KEY, true);
    setOpen(false);
    onClose?.();
  };

  return (
    <div className="tour-overlay" role="dialog" aria-label="SkyFlip quick tour" data-testid="first-run-tour">
      <div className="tour-card">
        <p className="hint">Step {step + 1} of {STEPS.length}</p>
        <p>{STEPS[step]}</p>
        <div className="row" style={{ marginTop: "0.75rem" }}>
          <button type="button" onClick={dismiss}>
            Skip
          </button>
          {step < STEPS.length - 1 ? (
            <button type="button" onClick={() => setStep((s) => s + 1)}>
              Next
            </button>
          ) : (
            <button type="button" onClick={dismiss}>
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
