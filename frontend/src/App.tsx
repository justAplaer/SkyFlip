import { candidateTimeTrack } from "./lib/candidateTimeTrack";
import { TimeMachinePanel } from "./components/TimeMachinePanel";
import { SpeedCard } from "./components/SpeedCard";
import { clampYear, dateToDecimalYear, interpolateTrack } from "./lib/timeMachineMath";
import type { TimeTrackResponse, MotionSpeedInfo } from "./types";
import { listBatches, getBatch, newBatch, batchChoice, type BatchChoice } from "./lib/batches";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AladinOverlay } from "./components/AladinOverlay";
import { Banner } from "./components/Banner";
import { BlinkPlayer } from "./components/BlinkPlayer";
import { CandidateList } from "./components/CandidateList";
import { ChangeSlider } from "./components/ChangeSlider";
import { AboutPanel } from "./components/AboutPanel";
import { DiscoveryMode } from "./components/DiscoveryMode";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FirstRunTour } from "./components/FirstRunTour";
import { FrameStrip } from "./components/FrameStrip";
import { StartChecklist } from "./components/StartChecklist";
import { readJsonPref, writeJsonPref } from "./lib/panelPrefs";
import { FullFrameStage } from "./components/FullFrameStage";
import { HistoricalPositionsPanel } from "./components/HistoricalPositionsPanel";
import { LimitsPanel } from "./components/LimitsPanel";
import { MetadataPanel } from "./components/MetadataPanel";
import { PixelInspectorPanel } from "./components/PixelInspectorPanel";
import { ReportObservation } from "./components/ReportObservation";
import { ScoreboardPanel } from "./components/ScoreboardPanel";
import { SearchBar, formatCoordBox } from "./components/SearchBar";
import { ShareMenu } from "./components/ShareMenu";
import { SpectrumPanel } from "./components/SpectrumPanel";
import { TargetButtons } from "./components/TargetButtons";
import { api, apiUrl, type PixelInspectResult } from "./lib/api";
import { cancelChangeScores, loadChangeScores } from "./lib/changeScoreClient";
import { trailFromScores } from "./lib/changeScoreMath";
import { detectorForTarget } from "./lib/detectorForTarget";
import { loadDemoCutouts } from "./lib/demoData";
import { frameWcs } from "./lib/frameWcs";
import { snapToKnownTarget } from "./lib/nearTarget";
import type { FrozenReportContext } from "./lib/observationTypes";
import { flushQueue, peekQueue } from "./lib/observationQueue";
import { manifestCenterMatch } from "./lib/skyMatch";
import { captionForTarget } from "./lib/targetCaptions";
import { readUrlState, shareUrl, viewFromUrl, writeUrlState } from "./lib/urlState";
import { pixelToWorld } from "./lib/wcsSky";
import type { ViewRect } from "./lib/zoomMath";
import type {
  ChangeMetric,
  ChangeReference,
  ChangeScoresResponse,
  ChangeSortMode,
  CutoutsResponse,
  FramePyramidMeta,
  HistoricalMarker,
  MissingMarker,
  MoverCandidate,
  PredictedTrackPoint,
  ProperMotionInfo,
  SpectrumPoint,
  TrailPoint,
} from "./types";
import { TEST_TARGETS, WISE0855 } from "./types";
import "./App.css";

type Tab = "viewer" | "scoreboard" | "about" | "discovery";
const SCIENTIST_KEY = "skyflip.scientistDetails";
const CHECKLIST_KEY = "skyflip.checklist.hidden";
type Focus ="overview" | "motion" | "speed" | "brightness" | "quality" | "report";
const FOCI: { id: Focus; label: string; title: string }[] = [
  { id: "overview", label: "Overview", title: "Images, data and historical positions" },
  { id: "motion", label: "Motion", title: "Movers, ghost track, historical positions, sky atlas" },
  { id: "speed", label: "How fast is it?", title: "Catalog-based motion and speed" },
  { id: "brightness", label: "Brightness", title: "Change ranking and spectrum" },
  { id: "quality", label: "Data quality", title: "Pixel inspector, flags and detection limits" },
  { id: "report", label: "Report & export", title: "Report an observation, share and export" },
];
type UiMode = "simple" | "expert";

export default function App() {
  const initial = readUrlState();
  const reduced = useMemo(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    []
  );
  const embed = Boolean(initial.embed);
  const labs =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("labs") === "1";
  const [tab, setTab] = useState<Tab>(() => {
    const t = initial.tab as Tab | undefined;
    return t === "discovery" && labs ? t : "viewer";
  });
  const [timeTrack, setTimeTrack] = useState<TimeTrackResponse | null>(null);
  const [motionSpeed, setMotionSpeed] = useState<MotionSpeedInfo | null>(null);
  const [timeError, setTimeError] = useState("");
  const [timeYear, setTimeYear] = useState(() => clampYear(dateToDecimalYear(new Date())));
  const [timePlaying, setTimePlaying] = useState(false);
  const [timeCenter, setTimeCenter] = useState(0);
  const [timeJump, setTimeJump] = useState<{id:string; nonce:number} | null>(null);
  const [welcome, setWelcome] = useState(true);
  const [batches, setBatches] = useState<BatchChoice[]>([]);
  const [batchProgress, setBatchProgress] = useState("");
  const [savedBatchError, setSavedBatchError] = useState("");
  const [selectedBatch, setSelectedBatch] = useState("");
  const [tourForce, setTourForce] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const openHelp = () => setHelpOpen(true);
  // "expert" = Scientist details on. URL ?mode= wins, else the remembered choice.
  const [uiMode, setUiMode] = useState<UiMode>(() =>
    initial.mode === "expert" || (initial.mode !== "simple" && readJsonPref(SCIENTIST_KEY, false))
      ? "expert"
      : "simple",
  );
  const expert = uiMode === "expert";
  useEffect(() => writeJsonPref(SCIENTIST_KEY, expert), [expert]);
  const [checklistHidden, setChecklistHidden] = useState(() => readJsonPref(CHECKLIST_KEY, false));
  const [epochMoves, setEpochMoves] = useState(0);
  const [reportedOnce, setReportedOnce] = useState(false);
  const [ra, setRa] = useState(initial.ra ?? WISE0855.ra);
  const [dec, setDec] = useState(initial.dec ?? WISE0855.dec);
  const [fov, setFov] = useState(initial.fov ?? 0.2);
  /** Empty string = free-text / no preset (never reuse another target's cache). */
  const [targetId, setTargetId] = useState(initial.target ?? "wise0855");
  const [name, setName] = useState(() => {
    const tid = initial.target ?? "wise0855";
    return TEST_TARGETS.find((t) => t.id === tid)?.name ?? "WISE 0855";
  });
  const [cutouts, setCutouts] = useState<CutoutsResponse | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [ghost, setGhost] = useState<PredictedTrackPoint[]>([]);
  const [historicalMarkers, setHistoricalMarkers] = useState<HistoricalMarker[]>([]);
  const [missingMarkers, setMissingMarkers] = useState<MissingMarker[]>([]);
  const [properMotion, setProperMotion] = useState<ProperMotionInfo | null>(null);
  const [pmMethod, setPmMethod] = useState("");
  const [showGhost, setShowGhost] = useState(true);
  const [movers, setMovers] = useState<MoverCandidate[]>([]);
  const [selectedMover, setSelectedMover] = useState<MoverCandidate | null>(null);
  const [moverStatus, setMoverStatus] = useState("");
  const [moverBusy, setMoverBusy] = useState(false);
  const [spectrum, setSpectrum] = useState<SpectrumPoint[]>([]);
  const [specNote, setSpecNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  /** Non-blanking load failure: keep prior frames; show reason + Retry. */
  const [loadBanner, setLoadBanner] = useState<{
    reason: string;
    retry: { ra: number; dec: number; name?: string; target?: string };
  } | null>(null);
  const [coordBox, setCoordBox] = useState(() =>
    formatCoordBox(initial.ra ?? WISE0855.ra, initial.dec ?? WISE0855.dec),
  );
  const [clickSky, setClickSky] = useState<{ ra: number; dec: number } | null>(null);
  const [stack, setStack] = useState<"none" | "detector" | "all_detectors">("none");
  const [detector, setDetector] = useState<number>(() =>
    detectorForTarget(initial.target ?? "wise0855"),
  );
  const [targetingMode, setTargetingMode] = useState<"fixed_sky" | "track_target">("fixed_sky");
  const [waveTol, setWaveTol] = useState<number | "">("");
  const [medianSub, setMedianSub] = useState(false);
  const [subtractZodi, setSubtractZodi] = useState(false);
  /** Full detector by default (tile pyramid); target_crop is the offline/demo fallback. */
  const [viewMode, setViewMode] = useState<"full_frame" | "target_crop">(
    initial.view === "target_crop" ? "target_crop" : "full_frame",
  );
  const loadGenRef = useRef(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Old ?tab=scoreboard / ?tab=about links land on the focus view that now holds them.
  const [focus, setFocus] = useState<Focus>(() =>
    initial.tab === "scoreboard" ? "quality" : "overview",
  );
  const [enlarged, setEnlarged] = useState(false);
  useEffect(() => {
    if (!enlarged) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setEnlarged(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enlarged]);
  const [demoStep, setDemoStep] = useState(() => (initial.demo ? 0 : -1));
  const [frameMetaExtra, setFrameMetaExtra] = useState<FramePyramidMeta | null>(null);
  const [stretchLimits, setStretchLimits] = useState<{
    lo: number;
    hi: number;
    mode: string;
  } | null>(null);
  const [diffUrl, setDiffUrl] = useState<string | null>(null);
  const [stretch, setStretch] = useState(initial.stretch || "asinh");
  const [clipLo, setClipLo] = useState(initial.clipLo ?? 1);
  const [clipHi, setClipHi] = useState(initial.clipHi ?? 99.5);
  // Hobbyists get smooth display of the small cached cutout (labelled "interpolated, not real
  // resolution" in Display settings); Scientist details keeps true pixels unless ?interp=1.
  const [interp, setInterp] = useState(Boolean(initial.interp) || uiMode !== "expert");
  const [cmap, setCmap] = useState(initial.cmap || "gray");
  const [showFlags, setShowFlags] = useState(Boolean(initial.flags));
  const [zoomView, setZoomView] = useState<ViewRect | null>(() => viewFromUrl(initial));

  const [cMetric, setCMetric] = useState<ChangeMetric>(
    (initial.cmetric as ChangeMetric) || "brightness_snr",
  );
  const [cRef, setCRef] = useState<ChangeReference>(
    (initial.cref as ChangeReference) || "median_others",
  );
  const [cAperture, setCAperture] = useState(initial.cap ?? 1.5);
  const [cSort, setCSort] = useState<ChangeSortMode>(
    (initial.csort as ChangeSortMode) || "time",
  );
  const [cRa, setCRa] = useState(initial.cra ?? initial.ra ?? WISE0855.ra);
  const [cDec, setCDec] = useState(initial.cdec ?? initial.dec ?? WISE0855.dec);
  const [cRangeLo, setCRangeLo] = useState<number | null>(initial.cmin ?? null);
  const [cRangeHi, setCRangeHi] = useState<number | null>(initial.cmax ?? null);
  const [changeScores, setChangeScores] = useState<ChangeScoresResponse | null>(null);
  const [changeBusy, setChangeBusy] = useState(false);
  const [changeProgress, setChangeProgress] = useState("");
  const [changeError, setChangeError] = useState("");
  const [keptEpochIds, setKeptEpochIds] = useState<string[]>([]);
  const keptKeyRef = useRef("");
  const onKeptEpochIds = useCallback((ids: string[]) => {
    const key = ids.join("\0");
    if (key === keptKeyRef.current) return;
    keptKeyRef.current = key;
    setKeptEpochIds(ids);
  }, []);
  const [pickAperture, setPickAperture] = useState(false);
  const [jumpEpochId, setJumpEpochId] = useState<string | null>(null);
  const changeDebounce = useRef<number | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [frozenReport, setFrozenReport] = useState<FrozenReportContext | null>(null);
  const [queueBanner, setQueueBanner] = useState("");
  const [pixelResult, setPixelResult] = useState<PixelInspectResult | null>(null);
  const [pixelBusy, setPixelBusy] = useState(false);
  const [pixelErr, setPixelErr] = useState("");

  const canReport =
    Number.isFinite(ra) &&
    Number.isFinite(dec) &&
    Boolean(cutouts?.frames && cutouts.frames.length >= 2);

  // Do not write epoch on every playback tick — only via onEpochCommit (step/pause).
  useEffect(() => {
    writeUrlState({
      ra,
      dec,
      fov,
      stretch,
      clipLo,
      clipHi,
      cmap,
      interp,
      flags: showFlags,
      embed,
      demo: initial.demo,
      tab,
      target: targetId,
      zx0: zoomView?.x0,
      zy0: zoomView?.y0,
      zx1: zoomView?.x1,
      zy1: zoomView?.y1,
      cmin: cRangeLo ?? undefined,
      cmax: cRangeHi ?? undefined,
      cmetric: cMetric,
      cref: cRef,
      cap: cAperture,
      csort: cSort,
      cra: cRa,
      cdec: cDec,
      mode: uiMode,
      view: viewMode,
    });
  }, [
    ra,
    dec,
    fov,
    stretch,
    clipLo,
    clipHi,
    cmap,
    interp,
    showFlags,
    embed,
    tab,
    targetId,
    initial.demo,
    zoomView,
    cRangeLo,
    cRangeHi,
    cMetric,
    cRef,
    cAperture,
    cSort,
    cRa,
    cDec,
    uiMode,
    viewMode,
  ]);

  const onEpochChange = useCallback((i: number) => {
    setEpoch(i);
    setEpochMoves((n) => n + 1);
  }, []);

  const onFullFrameMeta = useCallback(
    (
      m: FramePyramidMeta | null,
      s: { lo: number; hi: number; mode: string },
    ) => {
      setFrameMetaExtra(m);
      setStretchLimits(s);
    },
    [],
  );

  const onEpochCommit = useCallback((i: number) => {
    setEpoch(i);
    writeUrlState({
      ra,
      dec,
      fov,
      epoch: i,
      stretch,
      embed,
      demo: initial.demo,
      tab,
      target: targetId,
      zx0: zoomView?.x0,
      zy0: zoomView?.y0,
      zx1: zoomView?.x1,
      zy1: zoomView?.y1,
    });
  }, [ra, dec, fov, stretch, embed, tab, targetId, initial.demo, zoomView]);

  const onViewCommit = useCallback((view: ViewRect | null) => {
    setZoomView(view);
  }, []);

  const refreshChangeScores = useCallback(
    (opts: { ra: number; dec: number; target?: string }) => {
      if (changeDebounce.current) window.clearTimeout(changeDebounce.current);
      changeDebounce.current = window.setTimeout(() => {
        const preset = (opts.target ?? targetId)?.trim() || undefined;
        setChangeBusy(true);
        setChangeError("");
        setChangeProgress(
          preset
            ? "Loading cached change scores…"
            : "Fetching live IRSA cutouts for change scores…",
        );
        void loadChangeScores({
          ra: opts.ra,
          dec: opts.dec,
          radius: cAperture,
          metric: cMetric,
          reference: cRef,
          target: preset,
          onProgress: setChangeProgress,
        })
          .then((data) => {
            setChangeScores(data);
            setChangeError("");
          })
          .catch((e) => {
            setChangeScores(null);
            setChangeError(
              e instanceof Error ? e.message : "not computed: change scores unavailable",
            );
          })
          .finally(() => {
            setChangeBusy(false);
            setChangeProgress("");
          });
      }, 280);
    },
    [cAperture, cMetric, cRef, targetId],
  );

  const cancelLiveChangeScores = useCallback(() => {
    cancelChangeScores();
    setChangeBusy(false);
    setChangeProgress("");
    setChangeError("not computed: cancelled");
  }, []);

  const classifyLoadFailure = (raw: string): string => {
    const s = raw.toLowerCase();
    if (
      /no covering|no observation|returned no|empty|404/.test(s) &&
      !/network|timeout|abort|unreachable|502|503|curl/.test(s)
    ) {
      return "archive returned no observation covering this position";
    }
    if (/outside coverage|out of survey|not covered/.test(s)) {
      return "position outside coverage";
    }
    if (/network|timeout|abort|unreachable|failed to fetch|curl|502|econn|sia/.test(s)) {
      return "network or archive unreachable";
    }
    if (/503/.test(s) && /no observation|no covering|no cached data/.test(s)) {
      return "archive returned no observation covering this position";
    }
    if (/503|network|unreachable/.test(s)) {
      return "network or archive unreachable";
    }
    return "network or archive unreachable";
  };

  const loadField = async (opts: {
    ra: number;
    dec: number;
    name?: string;
    target?: string;
    view_mode?: "full_frame" | "target_crop";
    subtract_zodi?: boolean;
  }) => {
    setSelectedBatch(""); setSelectedMover(null); setMovers([]); setMoverStatus(""); setMoverBusy(false);
    const gen = ++loadGenRef.current;
    setBusy(true);
    setErr("");
    setLoadBanner(null);
    setClickSky(null);

    // Snap free-text coords within 30″ of a curated target → same path as its button.
    let useRa = opts.ra;
    let useDec = opts.dec;
    let useTarget = opts.target?.trim() || "";
    let useName = opts.name;
    if (!useTarget) {
      const snapped = snapToKnownTarget(useRa, useDec);
      if (snapped && snapped.ra != null && snapped.dec != null) {
        useRa = snapped.ra;
        useDec = snapped.dec;
        useTarget = snapped.id;
        useName = snapped.name;
      }
    }

    setRa(useRa);
    setDec(useDec);
    setCRa(useRa);
    setCDec(useDec);
    setCoordBox(formatCoordBox(useRa, useDec));
    if (useName) setName(useName);
    else if (!useTarget) setName("Custom position");
    if (useTarget) setTargetId(useTarget);
    else setTargetId("");

    // Keep prior frames on screen until new data arrives (never blank the viewer).
    setFrameMetaExtra(null);
    setDiffUrl(null);
    setChangeScores(null);
    setKeptEpochIds([]);
    keptKeyRef.current = "";
    setPixelResult(null);
    setPixelErr("");

    const modeWanted = opts.view_mode ?? viewMode;
    const zodiWanted = opts.subtract_zodi ?? subtractZodi;
    const detWanted = useTarget ? detectorForTarget(useTarget) : detector;
    if (useTarget) setDetector(detWanted);

    const isCustom = !useTarget;
    if (isCustom) {
      setTargetingMode("fixed_sky");
      setShowGhost(false);
    }

    try {
      let data: CutoutsResponse | null = null;
      const tryLive = async (mode: "full_frame" | "target_crop") =>
        api.cutouts({
          ra: useRa,
          dec: useDec,
          fov,
          target: useTarget || undefined,
          target_name: useName || name,
          stack,
          detector: detWanted,
          targeting_mode: isCustom ? "fixed_sky" : targetingMode,
          wavelength_tol_um: waveTol === "" ? undefined : Number(waveTol),
          median_subtract: medianSub,
          subtract_zodi: zodiWanted,
          view_mode: mode,
        });

      // Known demo targets: show curated crop immediately so the cyan target
      // marker is never blank while live SIA/full-frame is still fetching.
      // Applies in every View mode: live full-frame data replaces it when it arrives.
      if (useTarget) {
        const demo = await loadDemoCutouts(useTarget);
        if (gen !== loadGenRef.current) return;
        if (demo && manifestCenterMatch(useRa, useDec, demo)) {
          data = {
            ...demo,
            view_mode: "target_crop",
            subtract_zodi: false,
            note: `${demo.note ?? ""} · Cached target crop`.trim(),
          };
          setCutouts(data);
          setEpoch(0);
          if (modeWanted === "target_crop") setViewMode("target_crop");
          // Preset scores are cached too: don't make the change slider wait for live frames.
          refreshChangeScores({ ra: useRa, dec: useDec, target: useTarget });
        }
      }

      try {
        try {
          data = await tryLive(modeWanted);
        } catch (fullErr) {
          if (modeWanted === "full_frame") {
            try {
              data = await tryLive("target_crop");
            } catch {
              throw fullErr;
            }
          } else {
            throw fullErr;
          }
        }
      } catch (liveErr) {
        if (!data && useTarget) {
          const demo = await loadDemoCutouts(useTarget);
          if (gen !== loadGenRef.current) return;
          if (demo && manifestCenterMatch(useRa, useDec, demo)) {
            data = {
              ...demo,
              view_mode: "target_crop",
              subtract_zodi: false,
              note: `${demo.note ?? ""} · Cached target crop (full detector needs live IRSA)`.trim(),
            };
          }
        }
        if (!data) {
          const raw = liveErr instanceof Error ? liveErr.message : String(liveErr);
          throw new Error(classifyLoadFailure(raw));
        }
      }
      if (gen !== loadGenRef.current) return;
      if (data.source === "cached-demo") {
        data = { ...data, view_mode: "target_crop" };
      }
      if (data.frames.length === 1) {
        data = {
          ...data,
          note: `${data.note ? `${data.note}; ` : ""}only one epoch available, blink needs at least 2`,
        };
      }
      if (isCustom) {
        data = {
          ...data,
          note: `${data.note ? `${data.note}; ` : ""}Custom position — proper motion unknown; fixed sky, no ghost track`,
        };
      }
      setCutouts(data);
      setEpoch(0);
      setFrameMetaExtra(null);
      setViewMode(data.view_mode === "full_frame" ? "full_frame" : "target_crop");
      setLoadBanner(null);
      refreshChangeScores({
        ra: useRa,
        dec: useDec,
        target: useTarget || undefined,
      });
      if (isCustom) {
        setGhost([]);
        setHistoricalMarkers([]);
        setMissingMarkers([]);
        setProperMotion(null);
        setPmMethod(
          "Custom position — proper motion unknown; targeting fixed sky with no ghost track.",
        );
      } else {
        void api
          .predictedTrack(useRa, useDec, useName || name)
          .then((g) => {
            if (gen !== loadGenRef.current) return;
            setGhost(g.points);
            setHistoricalMarkers(g.historical_markers ?? []);
            setMissingMarkers(g.missing_markers ?? []);
            setProperMotion(g.proper_motion ?? null);
            setPmMethod(g.method ?? "");
          })
          .catch(() => {
            if (gen !== loadGenRef.current) return;
            setGhost([]);
            setHistoricalMarkers([]);
            setMissingMarkers([]);
            setProperMotion(null);
            setPmMethod("");
          });
      }
    } catch (e) {
      if (gen !== loadGenRef.current) return;
      // Keep previous cutouts/ghost on screen — never blank the viewer.
      const reason = e instanceof Error ? e.message : classifyLoadFailure(String(e));
      setLoadBanner({
        reason,
        retry: {
          ra: useRa,
          dec: useDec,
          name: useName,
          target: useTarget || undefined,
        },
      });
      setErr("");
    } finally {
      if (gen === loadGenRef.current) setBusy(false);
    }
  };

  useEffect(() => {
    void loadField({ ra, dec, name, target: targetId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => listBatches().then(({batches: saved}) => {
      if (active) { setSavedBatchError(""); setBatches(saved.filter(b => b.data.frames.length && b.status !== "running").map(batchChoice).reverse()); }
    }).catch(e => { if (active) setSavedBatchError(`Saved batches unavailable: ${e.message}`); });
    void refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const chooseBatch = async (id: string) => {
    if (!id) return;
    const gen = ++loadGenRef.current;
    setBusy(true);
    try {
      const b = batchChoice(await getBatch(id));
      if (gen !== loadGenRef.current) return;
      setSelectedMover(null); setMovers([]); setMoverStatus(""); setMoverBusy(false);
      setSelectedBatch(id); setRa(b.ra); setDec(b.dec); setCRa(b.ra); setCDec(b.dec);
      setCoordBox(formatCoordBox(b.ra, b.dec)); setFov(b.fov); setName(b.name); setTargetId(b.target);
      setDetector(b.detector); setViewMode(b.mode); setCutouts(b.data); setEpoch(0);
      setFrameMetaExtra(null); setDiffUrl(null); setChangeScores(null); setKeptEpochIds([]);
      keptKeyRef.current = ""; setErr(""); setLoadBanner(null); setBatchProgress("");
    } catch(e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { if (gen === loadGenRef.current) setBusy(false); }
  };

  const requestBatch = async (mode: "full_frame" | "target_crop", switching = false) => {
    const existing = switching ? batches.findLast(b => b.ra === ra && b.dec === dec && b.fov === fov && b.detector === detector && b.mode === mode) : undefined;
    if (existing) { void chooseBatch(existing.id); return; }
    const gen = ++loadGenRef.current;
    setBusy(true); setErr(""); setLoadBanner(null); setBatchProgress("Queued: 0/10 images");
    try {
      const saved = await newBatch({ra, dec, fov, detector, view_mode:mode, name, target:targetId}, setBatchProgress);
      if (gen !== loadGenRef.current) return;
      const b = batchChoice(saved);
      setBatches(prev => [...prev.filter(x=>x.id!==b.id), b]);
      setSelectedMover(null); setMovers([]); setMoverStatus(""); setMoverBusy(false);
      setSelectedBatch(b.id); setViewMode(mode); setCutouts(b.data); setEpoch(0);
      setBatchProgress(saved.warnings.length ? `Completed: ${saved.image_count}/10 images. ${saved.warnings.join(" ")}` : `Completed: ${saved.image_count}/10 images`);
      setFrameMetaExtra(null); setDiffUrl(null); setChangeScores(null); setKeptEpochIds([]); keptKeyRef.current = "";
    } catch (e) {
      if (gen === loadGenRef.current) { setBatchProgress(""); setErr(e instanceof Error ? e.message : String(e)); }
    } finally { if (gen === loadGenRef.current) setBusy(false); }
  };

  // Recompute scores when metric / reference / aperture / aperture sky pos change
  useEffect(() => {
    refreshChangeScores({ ra: cRa, dec: cDec, target: targetId });
  }, [cMetric, cRef, cAperture, cRa, cDec, targetId, refreshChangeScores]);

  const blinkFrames = useMemo(() => {
    const all = cutouts?.frames ?? [];
    // Default: blink ALL cutout epochs (≥5). Only apply the Change Slider
    // subset when the user has pinned an explicit score range.
    if (selectedBatch || cRangeLo == null || cRangeHi == null || !keptEpochIds.length) return all;
    const set = new Set(keptEpochIds);
    const filtered = all.filter((f) => set.has(f.epoch_id));
    if (filtered.length < 2) return all;
    if (cSort === "change") {
      const rank = new Map(keptEpochIds.map((id, i) => [id, i]));
      return [...filtered].sort(
        (a, b) => (rank.get(a.epoch_id) ?? 0) - (rank.get(b.epoch_id) ?? 0),
      );
    }
    return filtered;
  }, [cutouts, keptEpochIds, cSort, cRangeLo, cRangeHi, selectedBatch]);

  const trail: TrailPoint[] = useMemo(() => {
    if (!changeScores) return [];
    const set = new Set(keptEpochIds);
    const keptScores = changeScores.frames.filter((f) => set.has(f.epoch_id));
    return trailFromScores(keptScores.length ? keptScores : changeScores.frames);
  }, [changeScores, keptEpochIds]);

  const predictedTrail: TrailPoint[] = useMemo(() => {
    // Optional compare: ghost points that have x_pix/y_pix
    return ghost
      .filter((g) => g.x_pix != null && g.y_pix != null)
      .map((g, i) => ({
        epoch_id: g.epoch_id,
        mjd: g.mjd,
        x: g.x_pix as number,
        y: g.y_pix as number,
        index: i + 1,
      }));
  }, [ghost]);

  const apertureOverlay = useMemo(() => {
    if (!changeScores?.aperture_x_pix || changeScores.aperture_y_pix == null) {
      const fr = cutouts?.frames?.[0];
      const h = fr?.float_shape?.[0] ?? 117;
      const w = fr?.float_shape?.[1] ?? 117;
      return { x: (w - 1) / 2, y: (h - 1) / 2, r: cAperture };
    }
    return {
      x: changeScores.aperture_x_pix,
      y: changeScores.aperture_y_pix,
      r: cAperture,
    };
  }, [changeScores, cAperture]);

  // Jump blink to histogram-selected epoch
  useEffect(() => {
    if (!jumpEpochId || !blinkFrames.length) return;
    const i = blinkFrames.findIndex((f) => f.epoch_id === jumpEpochId);
    if (i >= 0) {
      setEpoch(i);
      onEpochCommit(i);
    }
    setJumpEpochId(null);
  }, [jumpEpochId, blinkFrames, onEpochCommit]);

  // Flush offline observation queue when API is reachable
  useEffect(() => {
    const API = import.meta.env.VITE_API_URL ?? "";
    void (async () => {
      const pending = await peekQueue().catch(() => []);
      if (!pending.length) return;
      setQueueBanner(`${pending.length} observation(s) queued — retrying…`);
      const { sent } = await flushQueue(async (payload) => {
        const r = await fetch(`${API}/api/observations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        return { ok: r.ok };
      });
      if (sent > 0) setQueueBanner(`Sent ${sent} queued observation(s).`);
      else setQueueBanner(`${pending.length} observation(s) still queued (backend unreachable).`);
    })();
  }, [cutouts?.source]);

  // Demo auto-walk
  useEffect(() => {
    if (!initial.demo) return;
    let i = 0;
    const id = window.setInterval(() => {
      const t = TEST_TARGETS[i % TEST_TARGETS.length];
      i += 1;
      void (async () => {
        if (t.ra != null && t.dec != null) {
          await loadField({ ra: t.ra, dec: t.dec, name: t.name, target: t.id });
        } else {
          const r = await api.resolve(t.name);
          await loadField({ ra: r.ra, dec: r.dec, name: t.name, target: t.id });
        }
      })();
    }, 12000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.demo]);

  const exportCandidates = () => {
    const payload = {
      ra,
      dec,
      fov,
      movers,
      credit: "NASA/JPL-Caltech/IPAC — SPHEREx at IRSA. SkyFlip candidates only.",
      disclaimer: "Not a discovery claim.",
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "skyflip_candidates.json";
    a.click();
  };

  const openReport = () => {
    if (!cutouts || !canReport) return;
    const snap: FrozenReportContext = {
      targetId: targetId,
      targetName: name,
      ra,
      dec,
      raDecSource: "target_button",
      fovDeg: fov,
      dataSource: cutouts.source,
      frames: cutouts.frames,
      keptEpochIds: keptEpochIds,
      shareUrl: shareUrl({
        ra,
        dec,
        fov,
        target: targetId,
        stretch,
        cmetric: cMetric,
        cref: cRef,
        cap: cAperture,
        csort: cSort,
        view: viewMode,
        mode: uiMode,
      }),
      display: {
        detector,
        stretch,
        targeting_mode: targetingMode,
        median_subtract: medianSub,
        wavelength_tol_um: waveTol === "" ? null : waveTol,
        change_slider: {
          metric: cMetric,
          reference: cRef,
          aperture: cAperture,
          sort: cSort,
          lo: cRangeLo,
          hi: cRangeHi,
        },
        show_ghost: showGhost,
      },
      imageWidth: 29,
      imageHeight: 29,
      pixelScaleArcsec: cutouts.pixel_scale_arcsec ?? 6.15,
    };
    const fs = cutouts.frames.find((f) => f.array_shape)?.array_shape ?? cutouts.frames.find((f) => f.float_shape)?.float_shape;
    if (fs) {
      snap.imageHeight = fs[0];
      snap.imageWidth = fs[1];
    }
    setFrozenReport({...snap, batchId:selectedBatch || undefined, imageMode:cutouts?.view_mode === "full_frame" ? "full_frame" : "target_crop"});
    setReportOpen(true);
    setReportedOnce(true);
  };

  const loadMovers = async () => {
    const gen = loadGenRef.current;
    setMoverBusy(true); setMovers([]); setSelectedMover(null); setMoverStatus("Searching the archive for possible movers...");
    try {
      const result = await api.movers(ra, dec, fov);
      if (gen !== loadGenRef.current) return;
      setMovers(result.movers);
      setMoverStatus(result.source === "cached-demo" ? "Cached result; confirm that it matches this sky field before interpreting it." : result.movers.length ? "Select a candidate below to follow its measured positions in Time Machine." : "No candidates were found for this request.");
    } catch (e) { if (gen === loadGenRef.current) setMoverStatus(`Mover search failed: ${e instanceof Error ? e.message : String(e)}`); }
    finally { if (gen === loadGenRef.current) setMoverBusy(false); }
  };

  const loadSpectrum = () =>
    void api
      .spectrum(ra, dec)
      .then((r) => {
        setSpectrum(r.points);
        setSpecNote(r.method_note);
      })
      .catch((e) => setErr(String(e)));

  useEffect(() => {
    setTimeTrack(null); setMotionSpeed(null); setTimeError("");
    if (!targetId) return;
    const controller = new AbortController();
    async function loadTimeTrack() {
      try {
        const response = await fetch(apiUrl(`/api/track?target=${encodeURIComponent(targetId)}&start=2010&end=2035&n=101`), {signal: controller.signal});
        if (!response.ok) throw new Error(`Track request failed (${response.status})`);
        const data: TimeTrackResponse = await response.json();
        if (!controller.signal.aborted) { setTimeTrack(data); setMotionSpeed(data.motion_speed ?? null); }
      } catch (err) { if (!controller.signal.aborted) setTimeError(err instanceof Error ? err.message : String(err)); }
    }
    void loadTimeTrack();
    return () => controller.abort();
  }, [targetId]);
  const setTimeClamped = useCallback((year: number) => setTimeYear(clampYear(year)), []);
  const selectedCandidateTrack = useMemo(() => selectedMover ? candidateTimeTrack(selectedMover) : null, [selectedMover]);
  const activeTrack = selectedMover ? selectedCandidateTrack : timeTrack;
  const timelineTrack = useMemo(() => {
    if (!activeTrack) return null;
    const frames = cutouts?.frames ?? [];
    const dates = frames.filter(f => Number.isFinite(f.mjd)).map(f => {
      const date = new Date((f.mjd - 40587) * 86400000);
      return { id: `frame_${f.epoch_id}`, kind: "spherex", label: `SPHEREx ${date.toISOString().slice(0, 10)}`, decimal_year: dateToDecimalYear(date), date_iso: date.toISOString().slice(0, 10), epoch_id: f.epoch_id };
    }).filter(d => d.decimal_year >= activeTrack.start_year && d.decimal_year <= activeTrack.end_year);
    return {...activeTrack, key_dates: [...activeTrack.key_dates.filter(k => k.kind !== "spherex"), ...dates].sort((a,b) => a.decimal_year-b.decimal_year)};
  }, [activeTrack, cutouts]);
  const timePoint = activeTrack?.is_mover ? interpolateTrack(activeTrack.points, timeYear) : null;
  const currentFrame = (blinkFrames.length ? blinkFrames : cutouts?.frames)?.[epoch];
  const dataBanner = (
    <Banner
      cached={cutouts?.source === "cached-demo" && manifestCenterMatch(ra, dec, cutouts)}
      synthetic={cutouts?.frames.some((f) => f.is_synthetic)}
    />
  );
  const metadataPanel = (
    <MetadataPanel
      frame={currentFrame}
      source={cutouts?.source}
      fovDeg={cutouts?.fov_deg ?? fov}
      pixelScaleArcsec={cutouts?.pixel_scale_arcsec ?? 6.15}
      subtractZodi={subtractZodi || cutouts?.subtract_zodi}
      viewMode={cutouts?.view_mode ?? viewMode}
      frameMeta={frameMetaExtra}
      stretchLimits={stretchLimits}
      showFlags={showFlags}
      onShowFlags={setShowFlags}
    />
  );

  return (
    <div className={`app ${embed ? "embed" : ""}`}>
      {welcome && !embed && <div className="welcome-screen" role="region" aria-label="Welcome to SkyFlip">
        <div className="welcome-art" aria-hidden="true" />
        <header className="welcome-nav"><span className="welcome-logo">Sky<span>Flip</span></span><span className="welcome-label">A WINDOW INTO A CHANGING SKY</span></header>
        <main className="welcome-content"><p className="welcome-eyebrow"><span /> EXPLORE SPHEREx DATA</p><h1>The sky is<br /><em>never still.</em></h1><p className="welcome-intro">Explore real observations from NASA’s SPHEREx mission. Compare images across time and look for objects that move or change.</p><button type="button" className="welcome-cta" onClick={() => setWelcome(false)}>Start exploring <span aria-hidden="true">↗</span></button><p className="welcome-note">No astronomy experience needed. Observations are candidates for review.</p></main>
        <footer className="welcome-footer"><div><strong>01</strong><span>Choose a sky region</span></div><div><strong>02</strong><span>Compare observations</span></div><div><strong>03</strong><span>Share what you find</span></div><a href="https://science.nasa.gov/photojournal/spherex-in-orbit-artists-concept/" target="_blank" rel="noreferrer">SPHEREx artist’s concept · NASA/JPL-Caltech ↗</a></footer>
      </div>}
      {!embed && (
        <header className="hero">
          <div>
            <p className="brand">
              Sky<em>Flip</em>
            </p>
            <p className="tag">
              The blink comparator that found <em>Pluto</em>, rebuilt for SPHEREx — with the evidence shown.
            </p>
          </div>
          {tab === "viewer" && (
            <SearchBar
              value={coordBox}
              onGoto={(r, d, n) =>
                void loadField({ ra: r, dec: d, name: n /* snap/clear handled in loadField */ })
              }
            />
          )}
          <nav className="tabs" aria-label="Focus views">
            <a href="/archive.html">Archive tools</a>
            {FOCI.map((f, i) => (
              <button
                key={f.id}
                type="button"
                aria-label={f.label}
                title={f.title}
                aria-pressed={tab === "viewer" && focus === f.id}
                className={tab === "viewer" && focus === f.id ? "active" : ""}
                onClick={() => {
                  setTab("viewer");
                  setFocus(f.id);
                  if (f.id === "brightness") setAdvancedOpen(true);
                }}
              >
                <span className="idx" aria-hidden>
                  0{i + 1}
                </span>
                {f.label}
              </button>
            ))}
            {labs && (
              <button
                type="button"
                className={tab === "discovery" ? "active" : ""}
                onClick={() => setTab("discovery")}
              >
                Discovery (labs)
              </button>
            )}
            <button
              type="button"
              role="switch"
              aria-checked={expert}
              className={`sci-switch ${expert ? "on" : ""}`}
              title="Show provenance, display settings and analysis tools"
              onClick={() => setUiMode(expert ? "simple" : "expert")}
            >
              <span className="track" aria-hidden />
              Scientist details
            </button>
            <button type="button" data-testid="help-tour" onClick={openHelp}>
              Help
            </button>
          </nav>
        </header>
      )}

      {(embed || tab !== "viewer") && dataBanner}
      {queueBanner && (
        <p className="banner-cached" role="status" data-testid="obs-queue-banner">
          {queueBanner}
        </p>
      )}

      {tab === "viewer" && !embed && (
        <div className="command">
          <div className="chips">
            <span className="focus-title">{FOCI.find((f) => f.id === focus)?.label}</span>
            <span className="eyebrow">Targets</span>
            <TargetButtons
              onSelect={(t) => {
                setCoordBox(formatCoordBox(t.ra, t.dec));
                void loadField({ ra: t.ra, dec: t.dec, name: t.name, target: t.id });
              }}
            />
            {dataBanner}
          </div>
        </div>
      )}

      {tab === "viewer" && (
        <main className={`layout ${expert && !embed ? "" : "two-col"}`}>
          {!embed && expert && (
            <aside className="side left" aria-label="Data">
              {metadataPanel}
            </aside>
          )}
          <section className={`primary ${enlarged ? "enlarged" : ""}`}>
            {!embed && (
              <>
                <button
                  type="button"
                  className="btn-enlarge"
                  aria-pressed={enlarged}
                  title={enlarged ? "Back to layout (Esc)" : "Enlarge the image"}
                  onClick={() => setEnlarged((v) => !v)}
                >
                  {enlarged ? "✕ Close" : "⤢ Enlarge"}
                </button>
                {!checklistHidden && (
                  <StartChecklist
                    played={epochMoves >= 2}
                    watched={epochMoves >= 5}
                    reported={reportedOnce}
                    onDismiss={() => {
                      setChecklistHidden(true);
                      writeJsonPref(CHECKLIST_KEY, true);
                    }}
                  />
                )}
              </>
            )}
            {err && <p className="error" role="alert">{err}</p>}
            {loadBanner && (
              <div
                className="banner-load-fail"
                role="alert"
                data-testid="load-fail-banner"
              >
                <p>
                  Couldn’t load frames for this position: <strong>{loadBanner.reason}</strong>.
                  Previous frames (if any) stay on screen.
                </p>
                <button
                  type="button"
                  data-testid="load-fail-retry"
                  disabled={busy}
                  onClick={() =>
                    void loadField({
                      ra: loadBanner.retry.ra,
                      dec: loadBanner.retry.dec,
                      name: loadBanner.retry.name,
                      target: loadBanner.retry.target,
                    })
                  }
                >
                  {busy ? "Retrying…" : "Retry"}
                </button>
              </div>
            )}
            {clickSky && (
              <div className="row wrap" data-testid="use-click-sky">
                <span className="hint">
                  Clicked sky {formatCoordBox(clickSky.ra, clickSky.dec)}
                </span>
                <button
                  type="button"
                  data-testid="use-this-position"
                  onClick={() => {
                    setCoordBox(formatCoordBox(clickSky.ra, clickSky.dec));
                    void loadField({ ra: clickSky.ra, dec: clickSky.dec });
                  }}
                >
                  Use this position
                </button>
              </div>
            )}
            {expert && cutouts?.note && <p className="hint">{cutouts.note}</p>}
            {(() => {
              const frs = blinkFrames.length ? blinkFrames : cutouts?.frames ?? [];
              const nAssist = frs.filter((f) => f.png_display_assist).length;
              if (!nAssist || !expert) return null;
              return (
                <p className="hint" role="status" data-testid="display-assist-note">
                  {nAssist}/{frs.length} frames use a labeled PNG display assist (IMAGE core
                  saturation-blanked). Float science bins are unaltered — not photometric
                  proof of flux. See docs/SCIENCE_LIMITS.md.
                </p>
              );
            })()}
            {demoStep >= 0 && (
              <section className="panel demo-guide" aria-label="Guided demo">
                <h2>Demo: WISE 0855</h2>
                <p>
                  {
                    [
                      "Open WISE 0855 — cold Y dwarf with large proper motion.",
                      "Fit the full detector, then Go to target and watch the ghost track.",
                      "Blink epochs — same sky patch; motion is a candidate only, not a discovery.",
                      "Open Advanced → Change slider to rank frames by aperture change.",
                      "SkyFlip never claims to discover Planet X.",
                    ][Math.min(demoStep, 4)]
                  }
                </p>
                <div className="row">
                  <button
                    type="button"
                    disabled={demoStep <= 0}
                    onClick={() => setDemoStep((s) => Math.max(0, s - 1))}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (demoStep === 0) {
                        const t = TEST_TARGETS.find((x) => x.id === "wise0855");
                        if (t?.ra != null && t.dec != null) {
                          void loadField({
                            ra: t.ra,
                            dec: t.dec,
                            name: t.name,
                            target: t.id,
                          });
                        }
                      }
                      setDemoStep((s) => Math.min(4, s + 1));
                    }}
                  >
                    {demoStep >= 4 ? "Done" : "Next"}
                  </button>
                  <button type="button" onClick={() => setDemoStep(-1)}>
                    Exit guide
                  </button>
                </div>
              </section>
            )}
            {cutouts ? (
              <ul
                className="sr-only"
                data-testid="obs-id-list"
                data-target-id={targetId}
                aria-hidden
              >
                {cutouts.frames.map((f) => (
                  <li key={f.epoch_id} data-obs-id={f.obs_id}>
                    {f.obs_id}
                  </li>
                ))}
              </ul>
            ) : null}
            {cutouts &&
            (cutouts.view_mode === "full_frame" ||
              cutouts.frames.some((f) => f.view_mode === "full_frame")) ? (
              <ErrorBoundary label="FullFrameStage">
                <FullFrameStage
                  expanded={expert}
                  timePoint={timePoint}
                  timeLabel={selectedMover ? "Interpolated" : "Predicted"}
                  timeTrail={activeTrack?.is_mover ? activeTrack.points : []}
                  holdBlink={timePlaying}
                  timeJump={timeJump}
                  timeCenter={timeCenter}
                  frames={blinkFrames.length ? blinkFrames : cutouts.frames}
                  fieldRa={ra}
                  fieldDec={dec}
                  subtractZodi={subtractZodi}
                  ghost={ghost}
                  showGhost={showGhost && Boolean(targetId)}
                  initialIndex={0}
                  onEpochChange={onEpochChange}
                  onMeta={onFullFrameMeta}
                  onSkyClick={(skyRa, skyDec) => setClickSky({ ra: skyRa, dec: skyDec })}
                />
              </ErrorBoundary>
            ) : cutouts ? (
              <ErrorBoundary label="BlinkPlayer">
                <BlinkPlayer
                  expanded={expert}
                  timePoint={timePoint}
                  timeLabel={selectedMover ? "Interpolated" : "Predicted"}
                  timeTrail={activeTrack?.is_mover ? activeTrack.points : []}
                  holdBlink={timePlaying}
                  timeJump={timeJump}
                  timeCenter={timeCenter}
                  frames={blinkFrames.length ? blinkFrames : cutouts.frames}
                  ghost={ghost}
                  historicalMarkers={historicalMarkers}
                  showGhost={showGhost && Boolean(targetId)}
                  reducedMotion={reduced}
                  stretch={stretch === "log" || stretch === "linear" ? stretch : "asinh"}
                  initialClipLo={clipLo}
                  initialClipHi={clipHi}
                  initialInterp={interp}
                  initialColormap={
                    cmap === "gray_inv" || cmap === "viridis" ? cmap : "gray"
                  }
                  initialShowFlags={showFlags}
                  backgroundNote={
                    (blinkFrames.length ? blinkFrames : cutouts.frames)[0]?.background_note
                  }
                  initialIndex={initial.epoch ?? 0}
                  onEpochChange={onEpochChange}
                  onEpochCommit={onEpochCommit}
                  onStretchCommit={(m) => setStretch(m)}
                  onDisplayCommit={(opts) => {
                    setStretch(opts.stretch);
                    setClipLo(opts.clipLo);
                    setClipHi(opts.clipHi);
                    setInterp(opts.interp);
                    setCmap(opts.cmap);
                    setShowFlags(opts.showFlags);
                  }}
                  fieldRa={ra}
                  fieldDec={dec}
                  pixelScaleArcsec={cutouts.pixel_scale_arcsec ?? 6.15}
                  markFieldCenter
                  initialView={zoomView}
                  onViewCommit={onViewCommit}
                  offline={cutouts.source === "cached-demo"}
                  trail={trail}
                  predictedTrail={showGhost && targetId ? predictedTrail : []}
                  aperture={apertureOverlay}
                  pickAperture={pickAperture}
                  onAperturePick={(xPix, yPix) => {
                    const frames = blinkFrames.length ? blinkFrames : cutouts.frames;
                    const fr = frames[epoch] ?? frames[0];
                    const wcs = frameWcs(fr, ra, dec, cutouts.pixel_scale_arcsec ?? 6.15);
                    if (wcs) {
                      const sky = pixelToWorld(wcs, xPix, yPix);
                      setCRa(sky.ra);
                      setCDec(sky.dec);
                    }
                  }}
                  onSkyClick={(skyRa, skyDec) => {
                    setClickSky({ ra: skyRa, dec: skyDec });
                    setCoordBox(formatCoordBox(skyRa, skyDec));
                  }}
                  onInspectPixel={
                    expert
                      ? (xPix, yPix) => {
                          const frames = blinkFrames.length ? blinkFrames : cutouts.frames;
                          const fr = frames[epoch] ?? frames[0];
                          if (!fr) return;
                          if (!targetId) {
                            setPixelResult(null);
                            setPixelErr(
                              "Inspector needs a cached demo preset (live float pack not wired for free-text fields).",
                            );
                            return;
                          }
                          setPixelBusy(true);
                          setPixelErr("");
                          void api
                            .pixel({
                              target: targetId,
                              epoch_id: fr.epoch_id,
                              x: xPix,
                              y: yPix,
                            })
                            .then((r) => {
                              setPixelResult(r);
                              setPixelErr("");
                            })
                            .catch((e) => {
                              setPixelResult(null);
                              setPixelErr(
                                e instanceof Error ? e.message : "Pixel inspect failed",
                              );
                            })
                            .finally(() => setPixelBusy(false));
                        }
                      : undefined
                  }
                  onRefetchRegion={(view) => {
                    const wPix = Math.abs(view.x1 - view.x0);
                    const newFov = Math.min(1, Math.max(0.02, (wPix * 6.15) / 3600));
                    setErr("");
                    setFov(newFov);
                    void loadField({ ra, dec, name, target: targetId });
                  }}
                />
              </ErrorBoundary>
            ) : null}
            <div className="under-image">
              <FrameStrip frame={currentFrame} source={cutouts?.source} />
              {busy && cutouts && (
                <span className="badge loading" role="status" data-testid="live-loading">
                  Live data loading… (cached shown)
                </span>
              )}
            <div className="row view-row" role="group" aria-label="Frame view mode">
              <label>
                <input
                  type="checkbox"
                  checked={subtractZodi}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setSubtractZodi(on);
                    void loadField({
                      ra,
                      dec,
                      name,
                      target: targetId,
                      subtract_zodi: on,
                    });
                  }}
                />{" "}
                <span title="Zodiacal light: sunlight scattered by dust in the solar system">Remove zodiacal glow ⓘ</span>
              </label>
              <div className="batch-controls" aria-label="Saved image batches">
                <button type="button" disabled={busy} onClick={() => void requestBatch(viewMode)}>Request new batch of 10</button>
                <label>Previous batches <select value={selectedBatch} onChange={e => void chooseBatch(e.target.value)}><option value="">Select a saved batch</option>{batches.map((batch, i) => <option key={batch.id} value={batch.id}>Batch {i + 1} · {batch.mode === "full_frame" ? "Full image" : "Cutout"} · {batch.data.frames.length} images</option>)}</select></label>
                {batchProgress && <span className="batch-counter" role="status" aria-live="polite">{batchProgress}</span>}
                {savedBatchError && <span className="error" role="status">{savedBatchError}</span>}
              </div>
              <label>
                View{" "}
                <select
                  value={viewMode}
                  onChange={(e) => {
                    const v = e.target.value as "full_frame" | "target_crop";
                    setViewMode(v);
                    void loadField({
                      ra,
                      dec,
                      name,
                      target: targetId,
                      view_mode: v,
                    });
                  }}
                  aria-label="Full frame or target crop"
                >
                  <option value="full_frame">Full frame</option>
                  <option value="target_crop">Target crop</option>
                </select>
              </label>
              {cutouts?.source === "cached-demo" && (
                <span className="badge" role="status">
                  Cached
                </span>
              )}
            </div>
              {!embed && (
                <div className="row wrap toolbar-actions" role="toolbar" aria-label="SkyFlip actions">
                  {!targetId && (
                    <span className="badge" role="status" data-testid="custom-field-chip">
                      Custom field — demo preset cleared
                    </span>
                  )}
                  {expert && (
                  <details className="toolbar-menu">
                    <summary>View</summary>
                    <div className="toolbar-menu-body" role="group" aria-label="View controls">
                      <label>
                        FOV {fov.toFixed(3)}°
                        <input
                          type="range"
                          min={0.05}
                          max={0.4}
                          step={0.01}
                          value={fov}
                          onChange={(e) => setFov(Number(e.target.value))}
                        />
                      </label>
                      <div className="fov-presets" role="group" aria-label="FOV presets">
                        <span className="hint">Presets</span>
                        {(
                          [
                            ["small", 0.08],
                            ["medium", 0.2],
                            ["large", 0.35],
                          ] as const
                        ).map(([label, v]) => (
                          <button
                            key={label}
                            type="button"
                            className={Math.abs(fov - v) < 0.01 ? "active" : ""}
                            onClick={() => setFov(v)}
                          >
                            {label}
                          </button>
                        ))}
                        <span className="hint">
                          Larger FOV tracks faster movers but transfers more data (~
                          {Math.round((fov / 0.2) * 100)}% of medium crop).
                        </span>
                      </div>
                      <label>
                        Detector
                        <select
                          value={detector}
                          onChange={(e) => setDetector(Number(e.target.value))}
                          aria-label="SPHEREx detector"
                        >
                          {[1, 2, 3, 4, 5, 6].map((d) => (
                            <option key={d} value={d}>
                              D{d}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Targeting
                        <select
                          value={targetingMode}
                          onChange={(e) =>
                            setTargetingMode(e.target.value as "fixed_sky" | "track_target")
                          }
                        >
                          <option value="fixed_sky">fixed sky (movers hop)</option>
                          <option value="track_target">track target (follow PM)</option>
                        </select>
                      </label>
                      <label>
                        Stack
                        <select
                          value={stack}
                          onChange={(e) =>
                            setStack(e.target.value as "none" | "detector" | "all_detectors")
                          }
                        >
                          <option value="none">none</option>
                          <option value="detector">this detector (S/N)</option>
                          <option value="all_detectors">all six detectors</option>
                        </select>
                      </label>
                      <label>
                        λ match ±µm
                        <input
                          type="number"
                          min={0}
                          step={0.05}
                          placeholder="off"
                          value={waveTol}
                          onChange={(e) =>
                            setWaveTol(e.target.value === "" ? "" : Number(e.target.value))
                          }
                          style={{ width: "4.5rem" }}
                        />
                      </label>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={medianSub}
                          onChange={(e) => setMedianSub(e.target.checked)}
                        />
                        Median-subtract
                      </label>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void loadField({ ra, dec, name, target: targetId })}
                      >
                        {busy ? "Loading…" : "Reload"}
                      </button>
                    </div>
                  </details>
                  )}

                  <label className="check">
                    <input
                      type="checkbox"
                      checked={showGhost}
                      onChange={(e) => setShowGhost(e.target.checked)}
                      aria-label="Ghost track (show predicted path)"
                    />
                    Show predicted path
                  </label>

                  {expert && (
                  <details className="toolbar-menu">
                    <summary>Analysis</summary>
                    <div className="toolbar-menu-body" role="group" aria-label="Analysis">
                      <button
                        type="button"
                        disabled={moverBusy}
                        onClick={() => { setFocus("motion"); void loadMovers(); }}
                      >
                        Detect movers
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void api
                            .spectrum(ra, dec)
                            .then((r) => {
                              setSpectrum(r.points);
                              setSpecNote(r.method_note);
                            })
                            .catch((e) => setErr(String(e)))
                        }
                      >
                        Load spectrum
                      </button>
                      <button
                        type="button"
                        disabled={!cutouts || cutouts.frames.length < 2}
                        onClick={() => {
                          const frames = cutouts?.frames ?? [];
                          if (frames.length < 2) return;
                          void api
                            .diff({
                              ra,
                              dec,
                              fov,
                              a: frames[0].epoch_id,
                              b: frames[frames.length - 1].epoch_id,
                              bandpass: `SPHEREx-D${detector}`,
                            })
                            .then((r) => {
                              if (r.wavelength_mismatched || !r.image_url) {
                                setDiffUrl(null);
                                setErr(
                                  r.note ||
                                    "Wavelength-mismatched frames — science diff refused"
                                );
                                return;
                              }
                              setDiffUrl(r.image_url);
                            })
                            .catch((e) => setErr(String(e)));
                        }}
                      >
                        Diff first−last
                      </button>
                    </div>
                  </details>
                  )}

                  <ShareMenu
                    state={{
                      ra,
                      dec,
                      fov,
                      target: targetId,
                      stretch: "asinh",
                      view: viewMode,
                      mode: uiMode,
                    }}
                    onExportCandidates={exportCandidates}
                    canExport={movers.length > 0}
                  />

                  <button
                    type="button"
                    data-testid="report-observation"
                    className="btn-report"
                    disabled={!canReport}
                    title={
                      canReport
                        ? "Report an unverified community observation"
                        : "Load a sky position with at least 2 frames first"
                    }
                    aria-keyshortcuts="Shift+R"
                    onClick={openReport}
                  >
                    Report an observation
                  </button>
                  {!canReport && <span className="hint">Load a target to report</span>}
                </div>
              )}
            </div>
            {!expert && !embed && cutouts && (
              <details className="provenance">
                <summary>Show provenance</summary>
                {metadataPanel}
              </details>
            )}
            {(() => {
              const cap = captionForTarget(targetId);
              if (!cap) return null;
              return (
                <p className="target-caption" data-testid="what-am-i-looking-at">
                  <strong>What am I looking at?</strong> {cap.text}
                  <cite>{cap.cite}</cite>
                </p>
              );
            })()}
            <details
              className="panel"
              open={advancedOpen}
              onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
            >
              <summary>Advanced</summary>
              <ChangeSlider
                scores={changeScores}
                loading={changeBusy}
                progress={changeProgress}
                error={changeError}
                onCancel={cancelLiveChangeScores}
                onRetry={() => refreshChangeScores({ ra: cRa, dec: cDec, target: targetId })}
                metric={cMetric}
                reference={cRef}
                aperture={cAperture}
                sortMode={cSort}
                rangeLo={cRangeLo}
                rangeHi={cRangeHi}
                onMetric={setCMetric}
                onReference={setCRef}
                onAperture={setCAperture}
                onSortMode={setCSort}
                onRange={(lo, hi) => {
                  setCRangeLo(lo);
                  setCRangeHi(hi);
                }}
                onKeptEpochIds={onKeptEpochIds}
                onJumpToEpochId={setJumpEpochId}
                pickMode={pickAperture}
                onPickMode={setPickAperture}
              />
              {diffUrl && (
                <div aria-label="Epoch difference">
                  <h2>Diff (first − last epoch)</h2>
                  <img src={apiUrl(diffUrl)} alt="Difference of first and last blink epochs" />
                  <p className="hint">
                    Aligned difference via /api/diff. Static stars cancel; movers remain.
                  </p>
                </div>
              )}
            </details>
            {!cutouts && busy && <div className="skeleton" aria-busy="true" />}
            {!cutouts && !busy && (
              <div className="empty-viewer" role="status">
                Pick a target above, or search a name or coordinates, to start.
              </div>
            )}
          </section>
          <aside className="side right" aria-label={`${FOCI.find((f) => f.id === focus)?.label} tools`}>
            {embed && metadataPanel}
            {(expert || focus === "quality") && (
              <PixelInspectorPanel
                result={pixelResult}
                busy={pixelBusy}
                err={pixelErr}
              />
            )}
            {(focus === "motion" || focus === "speed" || expert) && <>
              {!targetId && !selectedMover && <section className="panel"><h2>Time travel</h2><p>Choose a target preset, or detect and select a candidate to follow its measured positions.</p></section>}
              {targetId && !selectedMover && timeError && <p className="error" role="alert">Time travel unavailable: {timeError}</p>}
              {targetId && !selectedMover && !timeTrack && !timeError && <p role="status">Loading time travel and speed...</p>}
              {selectedMover && <section className="panel" role="status"><strong>Following candidate: {selectedMover.id}</strong><p>Interpolated between detected positions only, not a forecast. Detection may use different archive images from the selected batch. Candidates can be artifacts.</p><button type="button" onClick={() => setSelectedMover(null)}>{targetId ? "Return to preset track" : "Stop following candidate"}</button></section>}
              {(focus === "motion" || expert) && <TimeMachinePanel track={timelineTrack} year={timeYear} onYearChange={setTimeClamped} onPlayingChange={setTimePlaying} frameDecimalYear={currentFrame?.mjd ? dateToDecimalYear(new Date((currentFrame.mjd-40587)*86400000)) : null} reducedMotion={reduced} expert={expert} markerOutside={Boolean(timePoint)} onCenterOnObject={() => setTimeCenter(n => n + 1)} onSelectSpherexEpoch={(id) => setTimeJump({id, nonce: Date.now()})} />}
              {(focus === "speed" || focus === "motion" || expert) && !selectedMover && <SpeedCard speed={motionSpeed} expert={expert} />}
              {selectedMover && focus === "speed" && <p className="hint">Sun-relative speed is unavailable for an unverified candidate. Return to a preset to view its catalog speed.</p>}
            </>}
            {(focus === "overview" || focus === "motion") && (
              <HistoricalPositionsPanel
                properMotion={properMotion}
                pmMethod={pmMethod}
                historicalMarkers={historicalMarkers}
                missingMarkers={missingMarkers}
                targetId={targetId}
              />
            )}
            {focus === "motion" && (
              <section className="panel">
                <h2>Movers</h2>
                <button type="button" disabled={moverBusy} onClick={loadMovers}>
                  {moverBusy ? "Searching..." : "Detect movers"}
                </button>
                {moverStatus && <p className="hint" role="status">{moverStatus}</p>}
                <p className="hint">The search requests archive observations for this field; they may differ from the selected batch.</p>
              </section>
            )}
            {(expert || focus === "motion") && <CandidateList movers={movers} onSelect={(m) => { const track = candidateTimeTrack(m); if (!track) { setMoverStatus("This candidate needs at least two valid, distinct observation dates within 2010-2035 before Time Machine can animate it."); return; } setSelectedMover(m); setTimeYear(track.start_year); setMoverStatus(`Following ${m.id} in Time Machine. Select Play through time.`); setFocus("motion"); }} />}
            {focus === "brightness" && (
              <section className="panel">
                <h2>Spectrum</h2>
                <p className="hint">Change ranking is open under Advanced, below the image.</p>
                <button type="button" onClick={loadSpectrum}>
                  Load spectrum
                </button>
              </section>
            )}
            {(expert || focus === "brightness") && (
              <SpectrumPanel points={spectrum} methodNote={specNote} />
            )}
            {focus === "quality" && <ScoreboardPanel />}
            {focus === "quality" && <LimitsPanel />}
            {focus === "report" && (
              <section className="panel">
                <h2>Report &amp; export</h2>
                <p className="hint">
                  Reports are stored as unverified community observations with epoch IDs, MJD,
                  detector, λ and WCS. Candidates only — never a discovery claim.
                </p>
                <div className="row">
                  <button type="button" className="btn-report" disabled={!canReport} onClick={openReport}>
                    Report an observation
                  </button>
                  <button type="button" disabled={!movers.length} onClick={exportCandidates}>
                    Export candidates
                  </button>
                </div>
              </section>
            )}
            {(expert || focus === "motion") && !embed && (
              <AladinOverlay ra={ra} dec={dec} fov={Math.max(fov, 0.2)} />
            )}
          </aside>
        </main>
      )}

      {tab === "discovery" && labs && (
        <main className="single">
          <DiscoveryMode />
        </main>
      )}
      {!embed && (
        <footer>
          <p>
            Credits: NASA / JPL-Caltech / IPAC SPHEREx archive. MIT license. SkyFlip does not claim
            to discover Planet X. App v0.2.0 · data via IRSA SPHEREx DR1/QR3.
          </p>
          <p className="hint">
            Blink is capped at 3 Hz; reduced-motion preferences start paused for photosensitivity
            safety.
          </p>
        </footer>
      )}
      {!embed && tourForce && (
        <FirstRunTour
          forceOpen={tourForce}
          onClose={() => setTourForce(false)}
        />
      )}
      {helpOpen && (
        <div className="tour-overlay" role="dialog" aria-label="Keyboard help" data-testid="help-dialog">
          <div className="tour-card">
            <h2>Help</h2>
            <h3>Getting started</h3>
            <ol className="hint">
              <li>Pick a target, or search a name or coordinates.</li>
              <li>Press ▶ Blink and watch for a dot that jumps between visits.</li>
              <li>The cyan circle and predicted path show where a known mover should be.</li>
              <li>Saw something? Use Report an observation. Everything is a candidate, not a discovery.</li>
            </ol>
            <h3>Keyboard &amp; touch</h3>
            <ul className="hint">
              <li>Space — play/pause blink · ← → — step visits</li>
              <li>P / B — pan / box zoom (full frame)</li>
              <li>Esc / 0 — reset zoom · Back undoes the last zoom</li>
              <li>Wheel zooms on the cursor · pinch zooms on touch</li>
            </ul>
            <h3>Zoom and pan (Image tools)</h3>
            <ul className="hint">
              <li>Select-zoom: drag a box (at least 3×3 SPHEREx pixels); Enter zooms.</li>
              <li>Pan: the Pan tool, or hold Space / middle mouse / two-finger drag.</li>
              <li>Shift+arrows move the selection · +/− resize it.</li>
              <li>Hover the image for RA/Dec of the cursor (per-frame WCS).</li>
            </ul>
            <h3>Safety and limits</h3>
            <ul className="hint">
              <li>Blink is capped at 3 Hz; reduced-motion preferences start paused.</li>
              <li>Field of view, detector, λ and observation IDs are under Scientist details.</li>
            </ul>
            <AboutPanel />
            <div className="row">
              <button
                type="button"
                onClick={() => {
                  setHelpOpen(false);
                  setTourForce(true);
                  setChecklistHidden(false);
                  writeJsonPref(CHECKLIST_KEY, false);
                }}
              >
                Replay tour
              </button>
              <button type="button" onClick={() => setHelpOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <ReportObservation
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        context={frozenReport}
        reducedMotion={reduced}
      />
    </div>
  );
}
