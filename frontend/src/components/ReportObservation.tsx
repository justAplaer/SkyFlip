import { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl } from "../lib/api";
import { clearDraft, loadDraft, newIdempotencyKey, saveDraft } from "../lib/observationDraft";
import { enqueueObservation } from "../lib/observationQueue";
import {
  computedDirectionPa,
  defaultTanWcs,
  mapRectViaSky,
  normalizeRect,
  rectToSkyCorners,
  rectValid,
  type PixelRect,
} from "../lib/highlightMath";
import type { FrozenReportContext, ObservationDraft } from "../lib/observationTypes";
import { countWords, MAX_WORDS } from "../lib/wordcount";
import { HighlightPad } from "./HighlightPad";
import { SliderWithInput } from "./SliderWithInput";
import { ToggleSwitch } from "./ToggleSwitch";

const API = import.meta.env.VITE_API_URL ?? "";
const MIN_FRAMES = 2;
const MAX_FRAMES = 200;

interface Props {
  open: boolean;
  onClose: () => void;
  context: FrozenReportContext | null;
  reducedMotion?: boolean;
}

function emptyDraft(): ObservationDraft {
  return {
    selectedEpochIds: [],
    defaultRect: null,
    highlights: {},
    description: "",
    objectGuess: "not_sure",
    objectGuessOther: "",
    direction: "not_sure",
    confidence: 3,
    ease: "",
    contactEmail: "",
    contactConsent: false,
    storeConsent: false,
    isSyntheticFlag: false,
    formOpenedAt: Date.now(),
    idempotencyKey: newIdempotencyKey(),
  };
}

export function ReportObservation({ open, onClose, context, reducedMotion }: Props) {
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<ObservationDraft>(emptyDraft);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ id: string; queued?: boolean } | null>(null);
  const [activeFrame, setActiveFrame] = useState<string | null>(null);
  const [lastClicked, setLastClicked] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);

  // Freeze + init when opened
  useEffect(() => {
    if (!open || !context) return;
    const saved = loadDraft();
    const base = saved ?? emptyDraft();
    if (!saved?.selectedEpochIds?.length) {
      base.selectedEpochIds = context.frames.slice(0, Math.min(6, context.frames.length)).map(
        (f) => f.epoch_id,
      );
      if (base.selectedEpochIds.length < MIN_FRAMES && context.frames.length >= MIN_FRAMES) {
        base.selectedEpochIds = context.frames.slice(0, MIN_FRAMES).map((f) => f.epoch_id);
      }
    }
    base.formOpenedAt = Date.now();
    if (!saved) base.idempotencyKey = newIdempotencyKey();
    setDraft(base);
    setStep(1);
    setErr("");
    setReceipt(null);
    setActiveFrame(base.selectedEpochIds[0] ?? null);
    setDirty(false);
  }, [open, context]);

  useEffect(() => {
    if (!open) return;
    saveDraft(draft);
    setDirty(true);
  }, [draft, open]);

  const wcs = useMemo(() => {
    if (!context) return null;
    return defaultTanWcs(
      context.ra,
      context.dec,
      context.imageWidth,
      context.imageHeight,
      context.pixelScaleArcsec,
    );
  }, [context]);

  const selectedFrames = useMemo(() => {
    if (!context) return [];
    const set = new Set(draft.selectedEpochIds);
    return context.frames.filter((f) => set.has(f.epoch_id));
  }, [context, draft.selectedEpochIds]);

  const firstId = draft.selectedEpochIds[0] ?? null;

  const effectiveRect = useCallback(
    (epochId: string): PixelRect | null => {
      const h = draft.highlights[epochId];
      if (h?.mode === "custom") return h.pixel;
      return draft.defaultRect;
    },
    [draft.highlights, draft.defaultRect],
  );

  const updateDefaultRect = (r: PixelRect | null) => {
    setDraft((d) => {
      const next = { ...d, defaultRect: r ? normalizeRect(r) : null };
      if (r && wcs) {
        const highlights = { ...d.highlights };
        for (const id of d.selectedEpochIds) {
          const prev = highlights[id];
          if (!prev || prev.mode === "default") {
            highlights[id] = {
              epoch_id: id,
              mode: "default",
              pixel: normalizeRect(r),
              sky_corners: rectToSkyCorners(r, wcs),
            };
          }
        }
        next.highlights = highlights;
      }
      return next;
    });
  };

  const setFrameMode = (epochId: string, keepDefault: boolean) => {
    setDraft((d) => {
      const highlights = { ...d.highlights };
      if (keepDefault) {
        const pixel = d.defaultRect ?? highlights[epochId]?.pixel;
        if (!pixel || !wcs) return d;
        highlights[epochId] = {
          epoch_id: epochId,
          mode: "default",
          pixel: normalizeRect(pixel),
          sky_corners: rectToSkyCorners(pixel, wcs),
        };
      } else {
        const base = d.defaultRect ?? highlights[epochId]?.pixel;
        if (!base || !wcs) return d;
        const mapped = mapRectViaSky(base, wcs, wcs);
        highlights[epochId] = {
          epoch_id: epochId,
          mode: "custom",
          pixel: mapped,
          sky_corners: rectToSkyCorners(mapped, wcs),
        };
      }
      return { ...d, highlights };
    });
  };

  const toggleSelect = (epochId: string, index: number, shift: boolean) => {
    setDraft((d) => {
      let ids = [...d.selectedEpochIds];
      if (shift && lastClicked != null && context) {
        const a = Math.min(lastClicked, index);
        const b = Math.max(lastClicked, index);
        const range = context.frames.slice(a, b + 1).map((f) => f.epoch_id);
        const set = new Set([...ids, ...range]);
        ids = [...set];
      } else if (ids.includes(epochId)) {
        ids = ids.filter((x) => x !== epochId);
      } else {
        ids = [...ids, epochId];
      }
      if (ids.length > MAX_FRAMES) ids = ids.slice(0, MAX_FRAMES);
      return { ...d, selectedEpochIds: ids };
    });
    setLastClicked(index);
    setActiveFrame(epochId);
  };

  const wordCount = countWords(draft.description);
  const computed = useMemo(() => {
    if (!wcs || !draft.defaultRect) return null;
    const rects = draft.selectedEpochIds
      .map((id) => effectiveRect(id))
      .filter((r): r is PixelRect => !!r);
    return computedDirectionPa(rects, wcs);
  }, [draft.selectedEpochIds, draft.defaultRect, effectiveRect, wcs]);

  const tryClose = () => {
    if (dirty && !receipt) {
      if (!window.confirm("Discard unsaved observation report?")) return;
    }
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") tryClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const buildPayload = () => {
    if (!context || !wcs) throw new Error("missing context");
    const frames = selectedFrames.map((f) => ({
      epoch_id: f.epoch_id,
      obs_id: f.obs_id,
      mjd: f.mjd,
      time_iso: f.time_iso,
      detector: f.detector,
      bandpass: f.bandpass,
      central_wavelength_um: f.central_wavelength_um ?? null,
      collection: f.collection ?? "",
      pixel_scale_arcsec: context.pixelScaleArcsec,
      image_shape: [context.imageHeight, context.imageWidth],
      bunit: f.bunit ?? "MJy/sr",
      wcs: {},
      cutout_url: f.image_url,
      is_synthetic: Boolean(f.is_synthetic),
    }));
    const highlights = draft.selectedEpochIds.map((id) => {
      const pixel = effectiveRect(id);
      if (!pixel) throw new Error(`Missing highlight for ${id}`);
      const mode = draft.highlights[id]?.mode ?? "default";
      return {
        epoch_id: id,
        mode,
        pixel: normalizeRect(pixel),
        sky_corners: rectToSkyCorners(pixel, wcs),
      };
    });
    return {
      schema_version: 1,
      idempotency_key: draft.idempotencyKey,
      description: draft.description,
      context: {
        target_id: context.targetId ?? null,
        target_name: context.targetName ?? null,
        ra: context.ra,
        dec: context.dec,
        ra_dec_source: context.raDecSource,
        fov_deg: context.fovDeg,
        data_source: context.dataSource,
          batch_id: context.batchId,
          image_mode: context.imageMode,
      },
      frames,
      highlights,
      answers: {
        object_guess: draft.objectGuess,
        object_guess_other: draft.objectGuessOther,
        direction: draft.direction,
        confidence: draft.confidence,
        ease: draft.ease || null,
        computed_direction_pa_deg: computed?.paDeg ?? null,
        computed_direction_label: computed?.label ?? null,
      },
      display: {
        share_url: context.shareUrl,
        ...context.display,
      },
      is_synthetic_flag: draft.isSyntheticFlag || frames.some((f) => f.is_synthetic),
      honeypot: "",
      form_ms: Date.now() - draft.formOpenedAt,
      contact_email: draft.contactConsent ? draft.contactEmail || null : null,
      contact_consent: draft.contactConsent,
      allowed_epoch_ids: context.frames.map((f) => f.epoch_id),
    };
  };

  const submit = async () => {
    setErr("");
    if (!context) return;
    if (draft.selectedEpochIds.length < MIN_FRAMES) {
      setErr(`Select at least ${MIN_FRAMES} frames.`);
      return;
    }
    if (!draft.defaultRect) {
      setErr("Draw a highlight on the first selected frame.");
      return;
    }
    const v = rectValid(draft.defaultRect, context.imageWidth, context.imageHeight);
    if (!v.ok) {
      setErr(v.reason || "Invalid highlight");
      return;
    }
    if (wordCount > MAX_WORDS) {
      setErr(`Description exceeds ${MAX_WORDS} words (got ${wordCount}).`);
      return;
    }
    if (!draft.storeConsent) {
      setErr("Consent checkbox is required.");
      return;
    }
    setBusy(true);
    try {
      const payload = buildPayload();
      const r = await fetch(`${API}/api/observations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": draft.idempotencyKey },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        const body = await r.json();
        clearDraft();
        setReceipt({ id: body.submission_id });
        setDirty(false);
      } else if (r.status >= 500 || r.status === 0) {
        throw new Error("offline");
      } else {
        const body = await r.json().catch(() => ({}));
        const msgs = (body.errors as { field: string; message: string }[] | undefined)
          ?.map((e) => `${e.field}: ${e.message}`)
          .join("; ");
        setErr(msgs || body.detail || `Submit failed (${r.status})`);
      }
    } catch {
      try {
        const payload = buildPayload();
        await enqueueObservation(payload);
        clearDraft();
        setReceipt({ id: draft.idempotencyKey, queued: true });
        setDirty(false);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={tryClose}>
      <div
        className={`modal report-modal ${reducedMotion ? "reduced" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Report an observation"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Report an observation</h2>
          <p className="hint">
            Community observation, <strong>unverified</strong> — not a discovery.
          </p>
          <button type="button" className="modal-close" onClick={tryClose} aria-label="Close">
            ×
          </button>
        </header>

        {!context ? (
          <p className="error">No valid observation context. Load a target with frames first.</p>
        ) : receipt ? (
          <div className="report-success" data-testid="report-success">
            <p role="status">
              {receipt.queued
                ? "Queued — will send when online."
                : "Submitted. Thank you. This remains an unverified community observation."}
            </p>
            <p className="mono">
              Receipt ID: <span data-testid="receipt-id">{receipt.id}</span>
            </p>
            {receipt.queued && (
              <p className="banner-cached" role="status">
                using offline queue
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                setReceipt(null);
                setDraft(emptyDraft());
                setStep(1);
              }}
            >
              Report another
            </button>
            <button type="button" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            <nav className="stepper" aria-label="Form steps">
              {[1, 2, 3, 4].map((s) => (
                <span key={s} className={step === s ? "active" : ""}>
                  Step {s}
                </span>
              ))}
            </nav>

            {step === 1 && (
              <section>
                <h3>1. Choose images</h3>
                <p className="mono" data-testid="frame-select-count">
                  {draft.selectedEpochIds.length} of {context.frames.length} selected (min {MIN_FRAMES},
                  max {MAX_FRAMES})
                </p>
                <div className="row wrap">
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        selectedEpochIds: context.frames.map((f) => f.epoch_id).slice(0, MAX_FRAMES),
                      }))
                    }
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, selectedEpochIds: [] }))}
                  >
                    Select none
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        selectedEpochIds:
                          context.keptEpochIds.length >= MIN_FRAMES
                            ? context.keptEpochIds.slice(0, MAX_FRAMES)
                            : d.selectedEpochIds,
                      }))
                    }
                  >
                    Select change-slider frames
                  </button>
                </div>
                <div className="frame-strip" data-testid="frame-strip" role="list">
                  {context.frames.map((f, i) => {
                    const on = draft.selectedEpochIds.includes(f.epoch_id);
                    return (
                      <button
                        key={f.epoch_id}
                        type="button"
                        role="listitem"
                        className={`frame-thumb ${on ? "selected" : ""}`}
                        aria-pressed={on}
                        onClick={(e) => toggleSelect(f.epoch_id, i, e.shiftKey)}
                      >
                        <img src={apiUrl(f.image_url || (f.view_mode === "full_frame" ? `/api/frame/${encodeURIComponent(f.obs_id)}/${f.detector}/preview?subtract_zodi=false` : ""))} alt="" width={64} height={64} />
                        <span className="mono">
                          {f.mjd.toFixed(1)} · D{f.detector}
                          {f.central_wavelength_um != null
                            ? ` · ${f.central_wavelength_um.toFixed(2)}µm`
                            : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {step === 2 && (
              <section>
                <h3>2. Highlight where the object is</h3>
                <p className="hint">
                  Drag a blue rectangle on frame 1 (default). It applies to all selected frames unless
                  you switch a frame to custom.
                </p>
                {firstId && (
                  <HighlightPad
                    imageUrl={apiUrl(
                      (() => { const f = context.frames.find((frame) => frame.epoch_id === firstId); return f?.image_url || (f?.view_mode === "full_frame" ? `/api/frame/${encodeURIComponent(f.obs_id)}/${f.detector}/preview?subtract_zodi=false` : ""); })(),
                    )}
                    width={context.imageWidth}
                    height={context.imageHeight}
                    rect={draft.defaultRect}
                    onChange={updateDefaultRect}
                    label="Default highlight (1st selected frame)"
                  />
                )}
                <div className="row wrap">
                  <button
                    type="button"
                    onClick={() => {
                      if (!draft.defaultRect || !wcs) return;
                      setDraft((d) => {
                        const highlights = { ...d.highlights };
                        for (const id of d.selectedEpochIds) {
                          highlights[id] = {
                            epoch_id: id,
                            mode: "default",
                            pixel: normalizeRect(d.defaultRect!),
                            sky_corners: rectToSkyCorners(d.defaultRect!, wcs),
                          };
                        }
                        return { ...d, highlights };
                      });
                    }}
                  >
                    Reset all to default
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const cur = activeFrame ? effectiveRect(activeFrame) : draft.defaultRect;
                      if (!cur || !wcs) return;
                      updateDefaultRect(cur);
                      setDraft((d) => {
                        const highlights = { ...d.highlights };
                        for (const id of d.selectedEpochIds) {
                          highlights[id] = {
                            epoch_id: id,
                            mode: "default",
                            pixel: normalizeRect(cur),
                            sky_corners: rectToSkyCorners(cur, wcs),
                          };
                        }
                        return { ...d, defaultRect: normalizeRect(cur), highlights };
                      });
                    }}
                  >
                    Copy this highlight to all frames
                  </button>
                </div>
                <ul className="frame-toggle-list">
                  {selectedFrames.map((f) => {
                    const mode = draft.highlights[f.epoch_id]?.mode ?? "default";
                    const keepDefault = mode !== "custom";
                    return (
                      <li key={f.epoch_id}>
                        <div className="row wrap" style={{ alignItems: "center" }}>
                          <button type="button" onClick={() => setActiveFrame(f.epoch_id)}>
                            {f.time_iso || f.epoch_id.slice(0, 20)}
                          </button>
                          <ToggleSwitch
                            checked={keepDefault}
                            onChange={(on) => setFrameMode(f.epoch_id, on)}
                            labelOn="Keep the default (1st image) highlight"
                            labelOff="Custom highlight for this frame"
                          />
                        </div>
                        {!keepDefault && activeFrame === f.epoch_id && (
                          <HighlightPad
                            imageUrl={apiUrl(f.image_url || (f.view_mode === "full_frame" ? `/api/frame/${encodeURIComponent(f.obs_id)}/${f.detector}/preview?subtract_zodi=false` : ""))}
                            width={context.imageWidth}
                            height={context.imageHeight}
                            rect={effectiveRect(f.epoch_id)}
                            onChange={(r) => {
                              if (!r || !wcs) return;
                              setDraft((d) => ({
                                ...d,
                                highlights: {
                                  ...d.highlights,
                                  [f.epoch_id]: {
                                    epoch_id: f.epoch_id,
                                    mode: "custom",
                                    pixel: normalizeRect(r),
                                    sky_corners: rectToSkyCorners(r, wcs),
                                  },
                                },
                              }));
                            }}
                            label="Custom highlight for this frame"
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {step === 3 && (
              <section>
                <h3>3. Describe what you see</h3>
                <label>
                  Description (no personal information)
                  <textarea
                    rows={5}
                    value={draft.description}
                    maxLength={12000}
                    placeholder="Describe what moved, how, and anything unusual. Example: A faint point hopped ~2 pixels northeast between MJD … and …"
                    onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                    data-testid="report-description"
                  />
                </label>
                <p
                  className={`mono ${wordCount > MAX_WORDS ? "error" : ""}`}
                  data-testid="word-count"
                  aria-live="polite"
                >
                  {wordCount} / {MAX_WORDS} words
                </p>
                <label>
                  What do you think this object is?
                  <select
                    value={draft.objectGuess}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        objectGuess: e.target.value as ObservationDraft["objectGuess"],
                      }))
                    }
                  >
                    <option value="not_sure">not sure</option>
                    <option value="asteroid_sso">asteroid / solar system object</option>
                    <option value="nearby_high_pm">nearby star or brown dwarf (high motion)</option>
                    <option value="variable_or_brightness">variable / brightness change</option>
                    <option value="image_artifact">image artifact / noise</option>
                    <option value="cosmic_ray">cosmic ray</option>
                    <option value="simulated_injection">this is one of the simulated objects</option>
                    <option value="other">other</option>
                  </select>
                </label>
                {draft.objectGuess === "other" && (
                  <input
                    type="text"
                    value={draft.objectGuessOther}
                    onChange={(e) => setDraft((d) => ({ ...d, objectGuessOther: e.target.value }))}
                    placeholder="Short other label"
                  />
                )}
                <label>
                  Direction across the frames (required; “not sure” ok)
                  <select
                    value={draft.direction}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        direction: e.target.value as ObservationDraft["direction"],
                      }))
                    }
                    required
                    data-testid="direction-select"
                  >
                    <option value="not_sure">not sure</option>
                    <option value="up">up</option>
                    <option value="down">down</option>
                    <option value="left">left</option>
                    <option value="right">right</option>
                    <option value="up_left">up-left</option>
                    <option value="up_right">up-right</option>
                    <option value="down_left">down-left</option>
                    <option value="down_right">down-right</option>
                    <option value="brightness_only">doesn&apos;t move but changes brightness</option>
                  </select>
                </label>
                {computed && (
                  <p className="hint">
                    Computed from highlights (sky): {computed.label} (PA {computed.paDeg.toFixed(0)}°
                    E of N). Image up/left depends on display orientation.
                  </p>
                )}
                <SliderWithInput
                  id="report-confidence"
                  label="Confidence (1–5)"
                  min={1}
                  max={5}
                  step={1}
                  decimals={0}
                  value={draft.confidence}
                  onChange={(v) => setDraft((d) => ({ ...d, confidence: v }))}
                />
                <label>
                  How easy was it to see?
                  <select
                    value={draft.ease}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        ease: e.target.value as ObservationDraft["ease"],
                      }))
                    }
                  >
                    <option value="">(optional)</option>
                    <option value="obvious">obvious</option>
                    <option value="subtle">subtle</option>
                    <option value="after_zoom">only after zooming/stretching</option>
                  </select>
                </label>
                <fieldset className="contact-fieldset">
                  <legend>Optional contact (off by default)</legend>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={draft.contactConsent}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, contactConsent: e.target.checked }))
                      }
                    />
                    I consent to store my email only for a possible research follow-up. It can be
                    deleted on request. See privacy notice.
                  </label>
                  {draft.contactConsent && (
                    <input
                      type="email"
                      value={draft.contactEmail}
                      onChange={(e) => setDraft((d) => ({ ...d, contactEmail: e.target.value }))}
                      placeholder="email@example.com"
                      autoComplete="email"
                    />
                  )}
                </fieldset>
                <p className="hint">
                  <a href="/docs/PRIVACY_AND_DATA.md" target="_blank" rel="noreferrer">
                    Privacy notice
                  </a>{" "}
                  (also in repo docs/PRIVACY_AND_DATA.md)
                </p>
              </section>
            )}

            {step === 4 && (
              <section>
                <h3>4. Review and submit</h3>
                <ul className="review-list">
                  <li>
                    Frames: {draft.selectedEpochIds.length} selected
                  </li>
                  <li>
                    Highlight:{" "}
                    {draft.defaultRect
                      ? `${normalizeRect(draft.defaultRect).x0.toFixed(1)}…`
                      : "none"}
                  </li>
                  <li>
                    Words: {wordCount} / {MAX_WORDS}
                  </li>
                  <li>
                    Direction: {draft.direction}
                    {computed ? ` · computed ${computed.label}` : ""}
                  </li>
                  <li>Confidence: {draft.confidence}</li>
                  <li className="mono">Share URL snapshot: {context.shareUrl.slice(0, 80)}…</li>
                  <li>
                    Target: {context.targetName || "—"} · RA {context.ra.toFixed(5)} Dec{" "}
                    {context.dec.toFixed(5)}
                  </li>
                </ul>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.storeConsent}
                    onChange={(e) => setDraft((d) => ({ ...d, storeConsent: e.target.checked }))}
                    data-testid="store-consent"
                  />
                  I understand this report and the data listed here will be stored and may be shared
                  with researchers. It is an unverified community observation.
                </label>
              </section>
            )}

            {err && (
              <p className="error" role="alert">
                {err}
              </p>
            )}

            <footer className="modal-foot row wrap">
              {step > 1 && (
                <button type="button" onClick={() => setStep((s) => s - 1)}>
                  Back
                </button>
              )}
              {step < 4 && (
                <button
                  type="button"
                  onClick={() => {
                    setErr("");
                    if (step === 1 && draft.selectedEpochIds.length < MIN_FRAMES) {
                      setErr(`Select at least ${MIN_FRAMES} frames.`);
                      return;
                    }
                    if (step === 2) {
                      if (!draft.defaultRect) {
                        setErr("Draw a highlight first.");
                        return;
                      }
                      const v = rectValid(
                        draft.defaultRect,
                        context.imageWidth,
                        context.imageHeight,
                      );
                      if (!v.ok) {
                        setErr(v.reason || "Invalid highlight");
                        return;
                      }
                    }
                    if (step === 3 && wordCount > MAX_WORDS) {
                      setErr(`Description exceeds ${MAX_WORDS} words.`);
                      return;
                    }
                    setStep((s) => s + 1);
                  }}
                >
                  Next
                </button>
              )}
              {step === 4 && (
                <button
                  type="button"
                  disabled={busy}
                  data-testid="report-submit"
                  onClick={() => void submit()}
                >
                  {busy ? "Submitting…" : "Submit observation"}
                </button>
              )}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
