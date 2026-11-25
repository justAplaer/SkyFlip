import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { TimeTrackKeyDate, TimeTrackResponse } from "../types";
import { SliderWithInput } from "./SliderWithInput";
import {
  TIME_MACHINE_END,
  TIME_MACHINE_START,
  arcsecToSpherexPixels,
  formatMonthYear,
  formatShareDate,
  interpolateTrack,
  yearsDelta,
} from "../lib/timeMachineMath";

export interface TimeMachinePanelProps {
  track: TimeTrackResponse | null;
  year: number;
  onYearChange: (year: number) => void;
  /** MJD or decimal year of the currently displayed blink frame (for “offset from frame”). */
  frameDecimalYear: number | null;
  reducedMotion: boolean;
  onSelectSpherexEpoch?: (epochId: string) => void;
  markerOutside?: boolean;
  onCenterOnObject?: () => void;
  expert?: boolean;
  /** Fires when Play through time starts/stops — parent should freeze epoch blink. */
  onPlayingChange?: (playing: boolean) => void;
}

/** Max play rate: years of sky-time advanced per real second (safe for demo). */
const MAX_PLAY_YEARS_PER_SEC = 2.5;

export function TimeMachinePanel({
  track,
  year,
  onYearChange,
  frameDecimalYear,
  reducedMotion,
  onSelectSpherexEpoch,
  markerOutside = false,
  onCenterOnObject,
  expert = false,
  onPlayingChange,
}: TimeMachinePanelProps) {
  const baseId = useId().replace(/:/g, "");
  const [playing, setPlaying] = useState(false);
  const [playRate, setPlayRate] = useState(1);
  const rafRef = useRef<number | null>(null);
  const lastTs = useRef<number | null>(null);
  const yearRef = useRef(year);
  yearRef.current = year;
  const onPlayingChangeRef = useRef(onPlayingChange);
  onPlayingChangeRef.current = onPlayingChange;

  useEffect(() => {
    onPlayingChangeRef.current?.(playing);
  }, [playing]);

  useEffect(() => () => { onPlayingChangeRef.current?.(false); }, []);
  useEffect(() => { setPlaying(false); }, [track?.target_id, track?.source, track?.name]);

  const minYear = track?.source === "candidate" ? Math.max(TIME_MACHINE_START, track.start_year) : TIME_MACHINE_START;
  const maxYear = track?.source === "candidate" ? Math.min(TIME_MACHINE_END, track.end_year) : TIME_MACHINE_END;
  const selected = useMemo(
    () => (track ? interpolateTrack(track.points, year) : null),
    [track, year],
  );

  const nowYear = useMemo(() => {
    const d = new Date();
    return d.getUTCFullYear() + (d.getUTCMonth() + 0.5) / 12;
  }, []);

  useEffect(() => {
    if (!playing || !track || track.points.length < 2) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTs.current = null;
      return;
    }
    const tick = (ts: number) => {
      if (lastTs.current == null) lastTs.current = ts;
      const dt = (ts - lastTs.current) / 1000;
      lastTs.current = ts;
      const rate = Math.min(Math.max(playRate, 0.1), MAX_PLAY_YEARS_PER_SEC);
      const yearsPerSecond = track.source === "candidate" ? ((maxYear - minYear) / 8) * rate : rate;
      let next = yearRef.current + dt * yearsPerSecond;
      if (next >= maxYear) {
        next = maxYear;
        setPlaying(false);
      }
      onYearChange(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, playRate, track, onYearChange, minYear, maxYear]);

  if (!track) return null;

  const isMover = track.is_mover;
  const offsetFrame =
    frameDecimalYear != null ? yearsDelta(year, frameDecimalYear) : yearsDelta(year, nowYear);
  const offsetCatalog = selected?.offset_from_catalog_arcsec ?? 0;
  const uncRate = Number(track.proper_motion?.offset_uncertainty_rate_arcsec_yr);
  const dtCat = Math.abs(year - track.ref_epoch);
  const unc =
    Number.isFinite(uncRate) && uncRate > 0 ? uncRate * dtCat : null;

  const onTick = (k: TimeTrackKeyDate) => {
    onYearChange(k.decimal_year);
    if (k.kind === "spherex" && k.epoch_id && onSelectSpherexEpoch) {
      onSelectSpherexEpoch(k.epoch_id);
    }
  };

  return (
    <section
      className="panel time-machine"
      aria-label="Time machine"
      data-testid="time-machine"
    >
      <h2>Time machine</h2>
      <p className="hint" data-testid="time-machine-honesty">
        {track.honesty}
      </p>
      {!isMover && track.non_mover_message ? (
        <p className="hint" role="status" data-testid="time-machine-non-mover">
          {track.non_mover_message}
        </p>
      ) : null}
      {/* Full scrubber for all 5 demos — movers hop; variables stay put but still scrub years. */}
      {track.points.length > 0 ? (
        <>
          <div className="time-machine-readout" data-testid="time-machine-readout">
            <p className="time-machine-date">{formatMonthYear(year)}</p>
            <p className="hint">
              {offsetFrame >= 0 ? "+" : ""}
              {offsetFrame.toFixed(1)} years from{" "}
              {frameDecimalYear != null ? "this frame" : "today"}
              {" · "}
              {isMover ? (
                <>
                  moved {offsetCatalog.toFixed(1)}″ since {track.ref_epoch.toFixed(1)}
                  {" ≈ "}
                  {arcsecToSpherexPixels(offsetCatalog).toFixed(1)} SPHEREx px
                  {unc != null ? ` · σ≈${unc.toFixed(1)}″` : " · no uncertainty available"}
                </>
              ) : (
                <>held fixed in this visualization (small catalog motion omitted)</>
              )}
            </p>
          </div>

          <div
            className="time-machine-slider"
            onKeyDown={(e) => {
              const step = track.source === "candidate" ? (maxYear - minYear) * (e.shiftKey ? 0.1 : 0.01) : e.shiftKey ? 1 : 0.1;
              if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                e.preventDefault();
                onYearChange(Math.max(minYear, year - step));
              } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                e.preventDefault();
                onYearChange(Math.min(maxYear, year + step));
              } else if (e.key === "Home") {
                e.preventDefault();
                onYearChange(minYear);
              } else if (e.key === "End") {
                e.preventDefault();
                onYearChange(maxYear);
              }
            }}
          >
            <SliderWithInput
              id={`tm-${baseId}`}
              label="Year"
              min={minYear}
              max={maxYear}
              step={track.source === "candidate" ? Math.max((maxYear-minYear)/1000, 0.000001) : 0.1}
              decimals={track.source === "candidate" ? 5 : 1}
              value={track.source === "candidate" ? year : Number(year.toFixed(1))}
              onChange={onYearChange}
              unit=""
            />
          </div>

          <div className="time-machine-ticks" role="group" aria-label="Key dates">
            {track.key_dates.map((k) => (
              <button
                key={k.id}
                type="button"
                className={`tm-tick tm-tick-${k.kind}`}
                data-testid={`tm-tick-${k.kind}`}
                data-epoch-id={k.epoch_id ?? undefined}
                title={k.label}
                style={{
                  left: `${((k.decimal_year - minYear) / (maxYear - minYear)) * 100}%`,
                }}
                onClick={() => onTick(k)}
              >
                <span className="tm-tick-mark" aria-hidden />
                <span className="tm-tick-label">
                  {k.kind === "spherex"
                    ? k.date_iso.slice(0, 4)
                    : k.kind === "wise"
                      ? "WISE"
                      : k.kind === "gaia"
                        ? "Gaia"
                        : k.date_iso.slice(0, 4)}
                </span>
              </button>
            ))}
          </div>

          <div className="row wrap time-machine-actions">
            <button
              type="button"
              data-testid="tm-play"
              disabled={!track || track.points.length < 2}
              title="Animate the year slider; press again to pause"
              onClick={() => {
                if (!playing && year >= maxYear) { yearRef.current = minYear; onYearChange(minYear); }
                lastTs.current = null;
                setPlaying((p) => !p);
              }}
            >
              {playing ? "Pause time" : "Play through time"}
            </button>
            {reducedMotion && <p className="hint">Animation starts only when you press Play, because reduced motion is enabled.</p>}
            <label className="tm-rate">
              Timeline speed{" "}
              <input
                type="range"
                min={0.2}
                max={MAX_PLAY_YEARS_PER_SEC}
                step={0.1}
                value={playRate}
                aria-label={track.source === "candidate" ? "Animation speed multiplier" : "Time play speed in years per second"}
                onChange={(e) => setPlayRate(Number(e.target.value))}
              />
              <span>{playRate.toFixed(1)} {track.source === "candidate" ? "x" : "yr/s"}</span>
            </label>
            <button
              type="button"
              data-testid="tm-reset-now"
              onClick={() => {
                setPlaying(false);
                onYearChange(track.source === "candidate" ? minYear : nowYear);
              }}
            >
              {track.source === "candidate" ? "Reset to first observation" : "Reset to now"}
            </button>
            {markerOutside && onCenterOnObject && (
              <button type="button" data-testid="tm-center" onClick={onCenterOnObject}>
                Center on object
              </button>
            )}
          </div>

          <p className="hint">
            PM: {String(track.proper_motion.citation ?? "none")}.{" "}
            {String(track.proper_motion.uncertainty_note ?? "")}
            {expert ? ` · share ?t=${formatShareDate(year)}` : null}
          </p>
        </>
      ) : (
        <p className="hint" role="status" data-testid="time-machine-empty">
          {track.non_mover_message ||
            "Pick a demo target (e.g. Barnard's Star) to scrub Time machine and see km/s."}
        </p>
      )}
    </section>
  );
}
