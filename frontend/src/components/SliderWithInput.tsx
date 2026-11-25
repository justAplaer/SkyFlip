import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

export interface SliderWithInputProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  unit?: string;
  /** Decimal places shown in the number input (default: derived from step). */
  decimals?: number;
  id?: string;
  /** Number input may exceed `max` (slider stays pinned at `max`), up to `hardMax`. */
  allowBeyondMax?: boolean;
  hardMax?: number;
  /** Shown when a typed value was clamped (e.g. blink rate ≤ 3 Hz). */
  clampNote?: string;
}

function stepDecimals(step: number): number {
  const s = String(step);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** Clamp to [lo, hi], snapping to the `step` grid anchored at `min`. */
export function snapToRange(
  raw: number,
  min: number,
  upper: number,
  step: number,
  decimals: number,
): number {
  const bounded = Math.min(Math.max(raw, min), upper);
  let n = Math.round((bounded - min) / step);
  if (Number.isFinite(upper) && min + n * step > upper + 1e-9) n -= 1;
  const snapped = min + n * step;
  const out = Number(snapped.toFixed(Math.max(decimals, stepDecimals(step))));
  return Math.min(Math.max(out, min), upper);
}

/**
 * Range slider + number input kept in sync. Number input commits on Enter/blur
 * (clamp + round to step; NaN restores last good value with a brief red outline).
 * ArrowUp/Down = ±step, Shift+arrow = ±10·step.
 */
export function SliderWithInput({
  label,
  min,
  max,
  step,
  value,
  onChange,
  unit,
  decimals,
  id,
  allowBeyondMax = false,
  hardMax,
  clampNote,
}: SliderWithInputProps) {
  const autoId = useId();
  const baseId = id ?? `swi-${autoId.replace(/:/g, "")}`;
  const noteId = `${baseId}-note`;
  const dp = decimals ?? stepDecimals(step);
  const upper = allowBeyondMax ? (hardMax ?? Number.POSITIVE_INFINITY) : max;

  const fmt = (n: number) => n.toFixed(dp);
  const [text, setText] = useState(fmt(value));
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [clamped, setClamped] = useState(false);
  const invalidTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the text box in sync with external value changes (slider, parent state).
  useEffect(() => {
    if (!editing) setText(value.toFixed(dp));
  }, [value, dp, editing]);

  useEffect(
    () => () => {
      if (invalidTimer.current) clearTimeout(invalidTimer.current);
    },
    [],
  );

  const flashInvalid = () => {
    setInvalid(true);
    if (invalidTimer.current) clearTimeout(invalidTimer.current);
    invalidTimer.current = setTimeout(() => setInvalid(false), 800);
  };

  const commitText = () => {
    setEditing(false);
    const trimmed = text.trim();
    if (trimmed === fmt(value)) return; // untouched (e.g. blur after Enter)
    const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
    if (!Number.isFinite(parsed)) {
      flashInvalid();
      setText(fmt(value));
      return;
    }
    const next = snapToRange(parsed, min, upper, step, dp);
    setClamped(parsed < min || parsed > upper);
    setText(fmt(next));
    if (next !== value) onChange(next);
  };

  const nudge = (dir: 1 | -1, big: boolean) => {
    const base = Number.isFinite(Number(text)) && text.trim() !== "" ? Number(text) : value;
    const next = snapToRange(base + dir * step * (big ? 10 : 1), min, upper, step, dp);
    setClamped(false);
    setEditing(false);
    setText(fmt(next));
    if (next !== value) onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitText();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      nudge(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
    }
  };

  const sliderValue = Math.min(Math.max(value, min), max);
  const showNote = clamped && Boolean(clampNote);

  return (
    <div className="slider-with-input" data-testid={`${baseId}-wrap`}>
      <label htmlFor={baseId}>{label}</label>
      <input
        id={baseId}
        type="range"
        min={min}
        max={max}
        step={step}
        value={sliderValue}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onChange={(e) => {
          setClamped(false);
          onChange(Number(e.target.value));
        }}
      />
      <input
        id={`${baseId}-num`}
        type="text"
        inputMode="decimal"
        className={`slider-num${invalid ? " invalid" : ""}`}
        aria-label={`${label} value`}
        aria-invalid={invalid || undefined}
        aria-describedby={showNote ? noteId : undefined}
        value={text}
        onFocus={() => setEditing(true)}
        onChange={(e) => {
          setEditing(true);
          setText(e.target.value);
        }}
        onBlur={commitText}
        onKeyDown={onKeyDown}
      />
      {unit && <span className="slider-unit">{unit}</span>}
      {showNote && (
        <span id={noteId} className="hint slider-note" role="status">
          {clampNote}
        </span>
      )}
    </div>
  );
}
