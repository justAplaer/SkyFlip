/** Inline 3-step "first minute" guide shown above the image (replaces the pop-up tour). */
export function StartChecklist({
  played,
  watched,
  reported,
  onDismiss,
}: {
  played: boolean;
  watched: boolean;
  reported: boolean;
  onDismiss: () => void;
}) {
  const steps = [
    { done: played, text: "Press Blink" },
    { done: watched, text: "Spot the circled dot jumping between visits" },
    { done: reported, text: "Report what you saw" },
  ];
  return (
    <ol className="start-checklist" aria-label="Getting started" data-testid="start-checklist">
      {steps.map((s, i) => (
        <li key={s.text} className={s.done ? "done" : ""}>
          <span className="n" aria-hidden>
            {s.done ? "✓" : i + 1}
          </span>
          {s.text}
          {s.done && <span className="sr-only"> (done)</span>}
        </li>
      ))}
      <li className="dismiss">
        <button type="button" onClick={onDismiss} aria-label="Hide getting started">
          Hide
        </button>
      </li>
    </ol>
  );
}
