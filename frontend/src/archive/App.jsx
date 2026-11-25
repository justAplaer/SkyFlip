import presetTargets from "../data/targets.json";

import { useState, useEffect, useRef } from 'react';
import './App.css';
import AllSkyCubeExplorer from "./AllSkyCubeExplorer";

const API_URL = `${import.meta.env.VITE_API_URL ?? ""}/api/archive`;

function getImageSrc(accessUrl) {
  return `${API_URL}/image?url=${encodeURIComponent(accessUrl)}`;
}

// Convert wavelength values from meters to micrometers.
function formatWavelengthRange(emMin, emMax) {
  const min = Number(emMin);
  const max = Number(emMax);

  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min <= 0 ||
    max <= 0
  ) {
    return "Wavelength unavailable";
  }

  return `${(min * 1e6).toFixed(3)}–${(max * 1e6).toFixed(3)} µm`;
}

const PRESET_TARGETS = presetTargets.map(t=>({...t,ra:String(t.ra),dec:String(t.dec)}));

// Convert HMS or DMS coordinates into decimal degrees.
function parseSexagesimal(value, isRA) {
  const cleaned = value
    .trim()
    .replace(/[hHdD°mM'′sS"″]/g, ':')
    .replace(/\s+/g, ':')
    .replace(/:+$/, '');

  const parts = cleaned.split(':');

  if (parts.length !== 3) return NaN;

  const first = Number(parts[0]);
  const minutes = Number(parts[1]);
  const seconds = Number(parts[2]);

  if (
    !Number.isFinite(first) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    minutes < 0 || minutes >= 60 ||
    seconds < 0 || seconds >= 60
  ) {
    return NaN;
  }

  const sign = parts[0].startsWith('-') ? -1 : 1;
  const major = Math.abs(first);

  if (isRA) {
    if (
      sign < 0 ||
      major > 24 ||
      (major === 24 && (minutes !== 0 || seconds !== 0))
    ) {
      return NaN;
    }
  } else {
    if (
      major > 90 ||
      (major === 90 && (minutes !== 0 || seconds !== 0))
    ) {
      return NaN;
    }
  }

  const total = major + minutes / 60 + seconds / 3600;

  return isRA ? total * 15 : sign * total;
}

// Reusable zoomable image component.
function ZoomableImage({ src, alt, style = {} }) {
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 5;

  function changeZoom(amount) {
    setZoom((currentZoom) => {
      const nextZoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, currentZoom + amount)
      );

      if (nextZoom === MIN_ZOOM) {
        setPosition({ x: 0, y: 0 });
      }

      return nextZoom;
    });
  }

  function resetZoom() {
    setZoom(1);
    setPosition({ x: 0, y: 0 });
    dragRef.current = null;
  }

  function handleWheel(event) {
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? 0.2 : -0.2);
  }

  function handlePointerDown(event) {
    if (zoom <= 1 || event.button !== 0) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: position.x,
      startY: position.y
    };
  }

  function handlePointerMove(event) {
    if (
      !dragRef.current ||
      dragRef.current.pointerId !== event.pointerId
    ) {
      return;
    }

    event.preventDefault();

    const deltaX = event.clientX - dragRef.current.x;
    const deltaY = event.clientY - dragRef.current.y;

    setPosition({
      x: dragRef.current.startX + deltaX,
      y: dragRef.current.startY + deltaY
    });
  }

  function handlePointerUp(event) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  }

  return (
    <div className="zoomable-container" style={style}>
      <div
        className={`zoomable-viewport ${zoom > 1 ? "zoomed" : ""}`}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onDragStart={(event) => event.preventDefault()}
          className="zoomable-image"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`
          }}
        />
      </div>

      <div className="zoom-controls">
        <button onClick={() => changeZoom(0.5)} disabled={zoom >= MAX_ZOOM}>
          +
        </button>

        <span>{zoom.toFixed(1)}×</span>

        <button onClick={() => changeZoom(-0.5)} disabled={zoom <= MIN_ZOOM}>
          −
        </button>

        <button onClick={resetZoom}>Reset</button>
      </div>
    </div>
  );
}

function App() {
  const [ra, setRA] = useState("");
  const [dec, setDEC] = useState("");
  const [result, setResult] = useState(null);
  const [searchRadius, setSearchRadius] = useState("0.01");
  const [loadingMore, setLoadingMore] = useState(false);

  const [coordinateFormat, setCoordinateFormat] = useState("decimal");

  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [readyImageUrls, setReadyImageUrls] = useState(new Set());

  const [selectedBand, setSelectedBand] = useState("all");

  const [selectedUrl, setSelectedUrl] = useState("");
  const [selectedUrl2, setSelectedUrl2] = useState("");

  const [analysisResult, setAnalysisResult] = useState(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);

  // Spectral information state.
  const [spectralInfo, setSpectralInfo] = useState(null);
  const [loadingSpectralInfo, setLoadingSpectralInfo] = useState(false);
  const spectralRequestIdRef = useRef(0);

  // Gaia DR3 catalog state.
  const [gaiaSources, setGaiaSources] = useState(null);
  const [loadingGaia, setLoadingGaia] = useState(false);
  const [gaiaError, setGaiaError] = useState("");

  // Gaia overlay state.
  const [gaiaOverlay, setGaiaOverlay] = useState(null);
  const [loadingGaiaOverlay, setLoadingGaiaOverlay] = useState(false);
  const [gaiaOverlayError, setGaiaOverlayError] = useState("");
  const gaiaOverlayRequestIdRef = useRef(0);

  const [error, setError] = useState("");

  const initialUrlSearchProcessed = useRef(false);

  // Sort all loaded observations chronologically.
  const observations = [...(result?.observations || [])].sort((a, b) => {
    const timeA = Date.parse(a.observation_date);
    const timeB = Date.parse(b.observation_date);

    if (Number.isNaN(timeA) || Number.isNaN(timeB)) {
      return 0;
    }

    return timeA - timeB;
  });

  // Discover the bands actually returned by the API.
  const bandOptions = Array.from(
    new Set(
      observations
        .map((observation) => observation.energy_bandpassname)
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  // Filter observations using the selected band.
  const filteredObservations =
    selectedBand === "all"
      ? observations
      : observations.filter(
          (observation) =>
            observation.energy_bandpassname === selectedBand
        );

  const currentObservation = filteredObservations[currentIndex];

  const nextIndex =
    filteredObservations.length > 0
      ? (currentIndex + 1) % filteredObservations.length
      : 0;

  const nextObservation = filteredObservations[nextIndex];

  const currentImageSrc = currentObservation
    ? getImageSrc(currentObservation.access_url)
    : "";

  const nextImageSrc = nextObservation
    ? getImageSrc(nextObservation.access_url)
    : "";

  // Only display an overlay belonging to the currently displayed observation.
  const displayedImageSrc =
    gaiaOverlay &&
    gaiaOverlay.observationUrl === currentObservation?.access_url
      ? gaiaOverlay.src
      : currentImageSrc;

  const gaiaOverlayIsVisible =
    Boolean(gaiaOverlay) &&
    gaiaOverlay.observationUrl === currentObservation?.access_url;

  // Clear spectral information when the displayed observation changes.
  useEffect(() => {
    spectralRequestIdRef.current += 1;
    setSpectralInfo(null);
    setLoadingSpectralInfo(false);
  }, [currentObservation?.access_url]);

  // Clear the Gaia overlay when the displayed observation changes.
  useEffect(() => {
    gaiaOverlayRequestIdRef.current += 1;
    setGaiaOverlay(null);
    setGaiaOverlayError("");
    setLoadingGaiaOverlay(false);
  }, [currentObservation?.access_url]);

  // Release generated browser image URLs when the overlay is replaced or removed.
  useEffect(() => {
    return () => {
      if (gaiaOverlay?.src) {
        URL.revokeObjectURL(gaiaOverlay.src);
      }
    };
  }, [gaiaOverlay]);

  // Preload the current and next observation images.
  useEffect(() => {
    if (!currentImageSrc) return;

    const urlsToLoad = [
      ...new Set([currentImageSrc, nextImageSrc].filter(Boolean))
    ];

    const images = urlsToLoad.map((url) => {
      const image = new Image();

      const markAsReady = () => {
        setReadyImageUrls((previous) => {
          const updated = new Set(previous);
          updated.add(url);
          return updated;
        });
      };

      image.onload = markAsReady;
      image.onerror = markAsReady;
      image.src = url;

      if (image.complete) {
        markAsReady();
      }

      return image;
    });

    return () => {
      images.forEach((image) => {
        image.onload = null;
        image.onerror = null;
      });
    };
  }, [currentImageSrc, nextImageSrc]);

  // Automatically advance through observations during playback.
  useEffect(() => {
    if (!isPlaying || filteredObservations.length < 2) {
      return;
    }

    const currentReady = readyImageUrls.has(currentImageSrc);
    const nextReady = readyImageUrls.has(nextImageSrc);

    if (!currentReady || !nextReady) {
      return;
    }

    const timer = setTimeout(() => {
      setCurrentIndex(nextIndex);
    }, 1500);

    return () => clearTimeout(timer);
  }, [
    isPlaying,
    filteredObservations.length,
    currentIndex,
    nextIndex,
    currentImageSrc,
    nextImageSrc,
    readyImageUrls
  ]);

  async function handleSearch(
    raInput = ra,
    decInput = dec,
    format = coordinateFormat,
    radiusInput = searchRadius
  ) {
    if (raInput.trim() === "" || decInput.trim() === "") {
      setError("Please enter both coordinates.");
      return;
    }

    const raValue =
      format === "decimal"
        ? Number(raInput)
        : parseSexagesimal(raInput, true);

    const decValue =
      format === "decimal"
        ? Number(decInput)
        : parseSexagesimal(decInput, false);

    if (!Number.isFinite(raValue) || raValue < 0 || raValue > 360) {
      setError(
        format === "decimal"
          ? "Invalid RA. Enter a value between 0 and 360."
          : "Invalid RA. Use a format such as 08h55m10.831s."
      );
      return;
    }

    if (!Number.isFinite(decValue) || decValue < -90 || decValue > 90) {
      setError(
        format === "decimal"
          ? "Invalid DEC. Enter a value between -90 and 90."
          : "Invalid DEC. Use a format such as -07d14m42.53s."
      );
      return;
    }

    const radiusValue = Number(radiusInput);

    if (
      !Number.isFinite(radiusValue) ||
      radiusValue <= 0 ||
      radiusValue > 1
    ) {
      setError("Search radius must be greater than 0 and no more than 1 degree.");
      return;
    }

    try {
      setError("");
      setIsPlaying(false);
      setAnalysisResult(null);
      setSpectralInfo(null);
      setLoadingMore(false);

      // Clear catalog and overlay results when starting a new search.
      gaiaOverlayRequestIdRef.current += 1;
      setGaiaSources(null);
      setGaiaError("");
      setGaiaOverlay(null);
      setGaiaOverlayError("");
      setLoadingGaiaOverlay(false);

      const response = await fetch(
        `${API_URL}/search?ra=${raValue}&dec=${decValue}&radius=${radiusValue}&page=1`
      );

      if (!response.ok) {
        throw new Error("The server returned an error.");
      }

      const data = await response.json();

      const params = new URLSearchParams({
        ra: String(raValue),
        dec: String(decValue),
        radius: String(radiusValue)
      });

      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}?${params.toString()}${window.location.hash}`
      );

      setRA(String(raValue));
      setDEC(String(decValue));
      setSearchRadius(String(radiusValue));
      setCoordinateFormat("decimal");

      setSelectedBand("all");
      setSelectedUrl("");
      setSelectedUrl2("");
      setCurrentIndex(0);
      setReadyImageUrls(new Set());
      setResult(data);
    } catch (error) {
      setError(error.message || "Unable to connect to the backend.");
    }
  }

  // Automatically search if coordinates are provided in the URL.
  useEffect(() => {
    if (initialUrlSearchProcessed.current) {
      return;
    }

    initialUrlSearchProcessed.current = true;

    const params = new URLSearchParams(window.location.search);

    const urlRA = params.get("ra");
    const urlDEC = params.get("dec");
    const urlRadius = params.get("radius") || "0.01";

    if (urlRA !== null && urlDEC !== null) {
      setRA(urlRA);
      setDEC(urlDEC);
      setSearchRadius(urlRadius);
      setCoordinateFormat("decimal");

      handleSearch(urlRA, urlDEC, "decimal", urlRadius);
    }
  }, []);

  async function handleLoadMore() {
    if (!result || !result.has_more || loadingMore) {
      return;
    }

    try {
      setLoadingMore(true);
      setError("");

      const nextPage = result.page + 1;

      const response = await fetch(
        `${API_URL}/search?ra=${result.ra}&dec=${result.dec}&radius=${result.radius}&page=${nextPage}`
      );

      if (!response.ok) {
        throw new Error("Unable to load more observations.");
      }

      const data = await response.json();

      setResult((previous) => {
        const existingKeys = new Set(
          previous.observations.map(
            (observation) =>
              `${observation.obs_id}_${observation.energy_bandpassname}`
          )
        );

        const newObservations = data.observations.filter(
          (observation) =>
            !existingKeys.has(
              `${observation.obs_id}_${observation.energy_bandpassname}`
            )
        );

        return {
          ...previous,
          observations: [
            ...previous.observations,
            ...newObservations
          ],
          page: data.page,
          has_more: data.has_more,
          observations_found: data.observations_found
        };
      });
    } catch (error) {
      setError(error.message || "Unable to load more observations.");
    } finally {
      setLoadingMore(false);
    }
  }

  function handleBandChange(band) {
    setSelectedBand(band);
    setCurrentIndex(0);
    setIsPlaying(false);

    gaiaOverlayRequestIdRef.current += 1;
    setGaiaOverlay(null);
    setGaiaOverlayError("");
    setLoadingGaiaOverlay(false);

    setSelectedUrl("");
    setSelectedUrl2("");
    setAnalysisResult(null);
    setSpectralInfo(null);
  }

  function goToPrevious() {
    if (filteredObservations.length < 2) return;

    setCurrentIndex((index) =>
      (index - 1 + filteredObservations.length) %
      filteredObservations.length
    );
  }

  function goToNext() {
    if (filteredObservations.length < 2) return;

    setCurrentIndex((index) =>
      (index + 1) % filteredObservations.length
    );
  }

  // Request the wavelength at the searched sky position.
  async function handleGetSpectralInfo() {
    if (!currentObservation || !result) return;

    const requestId = ++spectralRequestIdRef.current;

    try {
      setLoadingSpectralInfo(true);
      setSpectralInfo(null);
      setError("");

      const params = new URLSearchParams({
        url: currentObservation.access_url,
        ra: String(result.ra),
        dec: String(result.dec)
      });

      const response = await fetch(
        `${API_URL}/spectral-info?${params.toString()}`
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.detail || "Unable to calculate spectral information."
        );
      }

      if (requestId === spectralRequestIdRef.current) {
        setSpectralInfo(data);
      }
    } catch (error) {
      if (requestId === spectralRequestIdRef.current) {
        setError(
          error.message || "Unable to retrieve spectral information."
        );
      }
    } finally {
      if (requestId === spectralRequestIdRef.current) {
        setLoadingSpectralInfo(false);
      }
    }
  }

  // Retrieve Gaia DR3 sources around the searched sky position.
  async function handleLoadGaiaSources() {
    if (!result) return;

    try {
      setLoadingGaia(true);
      setGaiaError("");
      setGaiaSources(null);

      gaiaOverlayRequestIdRef.current += 1;
      setGaiaOverlay(null);
      setGaiaOverlayError("");

      const params = new URLSearchParams({
        ra: String(result.ra),
        dec: String(result.dec),
        radius: String(result.radius)
      });

      const response = await fetch(
        `${API_URL}/gaia-sources?${params.toString()}`
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.detail || "Unable to retrieve Gaia catalog data."
        );
      }

      setGaiaSources(data);
    } catch (error) {
      console.error("Gaia catalog request failed:", error);

      setGaiaError(
        "Unable to connect to the Gaia catalog. Please try again later."
      );
    } finally {
      setLoadingGaia(false);
    }
  }

  // Generate an image with Gaia DR3 catalog positions drawn over it.
  async function handleLoadGaiaOverlay() {
    if (!currentObservation || !gaiaSources?.sources?.length) {
      return;
    }

    // Capture the observation so we can reject a stale response.
    const observationUrl = currentObservation.access_url;
    const requestId = ++gaiaOverlayRequestIdRef.current;

    try {
      setLoadingGaiaOverlay(true);
      setGaiaOverlayError("");

      const response = await fetch(`${API_URL}/gaia-overlay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: observationUrl,
          sources: gaiaSources.sources,
          observation_mjd: currentObservation.t_min ?? null
        })
      });

      if (!response.ok) {
        let message = "Could not generate the Gaia overlay.";

        try {
          const errorData = await response.json();
          message = errorData.detail || message;
        } catch {
          // Keep the default message if the response isn't JSON.
        }

        throw new Error(message);
      }

      const imageBlob = await response.blob();

      // Ignore the response if the user has already changed observations.
      if (requestId !== gaiaOverlayRequestIdRef.current) {
        return;
      }

      const imageUrl = URL.createObjectURL(imageBlob);

      setGaiaOverlay({
        src: imageUrl,
        observationUrl
      });
    } catch (error) {
      if (requestId === gaiaOverlayRequestIdRef.current) {
        setGaiaOverlayError(
          error.message || "Unable to generate the Gaia overlay."
        );
      }
    } finally {
      if (requestId === gaiaOverlayRequestIdRef.current) {
        setLoadingGaiaOverlay(false);
      }
    }
  }

  function handleToggleGaiaOverlay() {
    if (gaiaOverlayIsVisible) {
      gaiaOverlayRequestIdRef.current += 1;
      setGaiaOverlay(null);
      setGaiaOverlayError("");
      setLoadingGaiaOverlay(false);
      return;
    }

    handleLoadGaiaOverlay();
  }

  async function handleAnalyze() {
    if (!selectedUrl || !selectedUrl2) {
      setError("Please select two observations first.");
      return;
    }

    if (selectedUrl === selectedUrl2) {
      setError("Please select two different observations.");
      return;
    }

    try {
      setLoadingAnalysis(true);
      setError("");
      setAnalysisResult(null);

      const response = await fetch(`${API_URL}/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url1: selectedUrl,
          url2: selectedUrl2
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Analysis failed.");
      }

      setAnalysisResult(data);
    } catch (error) {
      setError(error.message || "Unable to complete the analysis.");
    } finally {
      setLoadingAnalysis(false);
    }
  }

  const wavelengthMarkerPosition = spectralInfo
    ? Math.max(
        0,
        Math.min(
          100,
          ((spectralInfo.wavelength_um - 0.75) / (5.0 - 0.75)) * 100
        )
      )
    : 0;

  return (
    <div>
      <h1>SPHEREx Motion Explorer</h1>

      <p>
        Search real SPHEREx observations, view them chronologically,
        and explore candidate changes in the sky.
      </p>

      <p>
        This tool identifies image differences for further investigation.
        Candidate differences are not confirmed moving objects.
      </p>

      <AllSkyCubeExplorer />

      <h2>Search the Sky</h2>

      <label htmlFor="coordinate-format">
        Coordinate Format
      </label>

      <select
        id="coordinate-format"
        value={coordinateFormat}
        onChange={(event) => {
          setCoordinateFormat(event.target.value);
          setRA("");
          setDEC("");
          setError("");
        }}
      >
        <option value="decimal">Decimal Degrees</option>
        <option value="sexagesimal">
          Hours / Degrees, Minutes, Seconds
        </option>
      </select>

      <input
        type="text"
        placeholder={
          coordinateFormat === "decimal"
            ? "Enter RA (0–360)"
            : "RA (e.g. 08h55m10.831s)"
        }
        value={ra}
        onChange={(event) => setRA(event.target.value)}
      />

      <input
        type="text"
        placeholder={
          coordinateFormat === "decimal"
            ? "Enter DEC (-90 to 90)"
            : "DEC (e.g. -07d14m42.53s)"
        }
        value={dec}
        onChange={(event) => setDEC(event.target.value)}
      />

      <label htmlFor="search-radius">
        Search Radius (degrees)
      </label>

      <input
        id="search-radius"
        type="number"
        min="0.0001"
        max="1"
        step="0.01"
        value={searchRadius}
        onChange={(event) => setSearchRadius(event.target.value)}
      />

      <p>
        Current search radius: {searchRadius}°
      </p>

      <p>
        {coordinateFormat === "decimal"
          ? "Enter RA and DEC in decimal degrees."
          : "Enter RA in hours, minutes, seconds and DEC in degrees, minutes, seconds."}
      </p>

      <h3>NASA Test Targets</h3>

      <p>
        Select a target to automatically search its SPHEREx observations.
      </p>

      <div className="preset-targets">
        {PRESET_TARGETS.map((target) => (
          <button
            key={target.name}
            onClick={() => {
              setCoordinateFormat("decimal");
              setRA(target.ra);
              setDEC(target.dec);
              handleSearch(target.ra, target.dec, "decimal");
            }}
          >
            {target.name}
          </button>
        ))}
      </div>

      <button onClick={handleSearch}>Search Observations</button>

      {error && <p style={{ color: "red" }}>{error}</p>}

      {result && (
        <div>
          <h2>Search Results</h2>

          <p>RA: {result.ra}°</p>
          <p>DEC: {result.dec}°</p>

          {/* Gaia DR3 catalog explorer */}
          <section className="gaia-explorer">
            <h2>Gaia DR3 Star Catalog</h2>

            <p>
              Retrieve known astronomical sources near your searched
              SPHEREx coordinates using the Gaia DR3 catalog.
            </p>

            <p>
              Search radius: {result.radius}°
            </p>

            <button
              onClick={handleLoadGaiaSources}
              disabled={loadingGaia}
            >
              {loadingGaia
                ? "Loading Gaia sources..."
                : "Load Gaia DR3 Sources"}
            </button>

            {gaiaError && (
              <p role="alert" style={{ color: "red" }}>
                Gaia catalog unavailable: {gaiaError}
              </p>
            )}

            {gaiaSources && (
              <div>
                <h3>Catalog Results</h3>

                <p>
                  Sources returned:{" "}
                  <strong>{gaiaSources.sources_found}</strong>
                </p>

                {gaiaSources.sources_found > 0 ? (
                  <div style={{ overflowX: "auto" }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Source ID</th>
                          <th>RA (°)</th>
                          <th>DEC (°)</th>
                          <th>G Magnitude</th>
                          <th>Parallax (mas)</th>
                        </tr>
                      </thead>

                      <tbody>
                        {gaiaSources.sources.map((source) => (
                          <tr key={source.source_id}>
                            <td>{source.source_id}</td>
                            <td>
                              {source.ra?.toFixed(6) ?? "—"}
                            </td>
                            <td>
                              {source.dec?.toFixed(6) ?? "—"}
                            </td>
                            <td>
                              {source.phot_g_mean_mag?.toFixed(3) ?? "—"}
                            </td>
                            <td>
                              {source.parallax?.toFixed(3) ?? "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>
                    No Gaia sources were returned for this search region.
                  </p>
                )}

                <p>
                  Catalog: {gaiaSources.catalog}
                </p>

                {gaiaSources.sources_found > 0 && (
                  <div className="gaia-overlay-controls">
                    <button
                      onClick={handleToggleGaiaOverlay}
                      disabled={loadingGaiaOverlay || !currentObservation}
                    >
                      {loadingGaiaOverlay
                        ? "Generating Gaia overlay..."
                        : gaiaOverlayIsVisible
                          ? "Hide Gaia Overlay"
                          : "Show Gaia Overlay"}
                    </button>

                    {gaiaOverlayError && (
                      <p role="alert" style={{ color: "red" }}>
                        {gaiaOverlayError}
                      </p>
                    )}

                    <p>
                      The overlay marks Gaia DR3 catalog positions with
                      cyan circles. These markers indicate catalog positions,
                      not confirmed detections in the SPHEREx image.
                    </p>
                  </div>
                )}
              </div>
            )}
          </section>

          <p>
            Loaded observations: {observations.length}
            {" "}of {result.observations_found}
          </p>

          <section className="band-explorer">
            <h2>Spectral Band Explorer</h2>

            <p>
              Select a SPHEREx band to explore its observations
              chronologically.
            </p>

            <label htmlFor="spectral-band">
              Select Spectral Band
            </label>

            <select
              id="spectral-band"
              value={selectedBand}
              onChange={(event) => handleBandChange(event.target.value)}
            >
              <option value="all">
                All bands ({observations.length} loaded observations)
              </option>

              {bandOptions.map((band) => {
                const bandObservations = observations.filter(
                  (observation) =>
                    observation.energy_bandpassname === band
                );

                const representative = bandObservations.find(
                  (observation) =>
                    observation.em_min != null &&
                    observation.em_max != null
                );

                const wavelengthLabel = representative
                  ? formatWavelengthRange(
                      representative.em_min,
                      representative.em_max
                    )
                  : "Wavelength unavailable";

                return (
                  <option key={band} value={band}>
                    {band} — {wavelengthLabel} ({bandObservations.length} loaded)
                  </option>
                );
              })}
            </select>

            <div className="band-summary">
              {selectedBand === "all" ? (
                <p>
                  Displaying observations from all available bands.
                </p>
              ) : (
                <>
                  <h3>{selectedBand}</h3>

                  {(() => {
                    const representative = observations.find(
                      (observation) =>
                        observation.energy_bandpassname === selectedBand &&
                        observation.em_min != null &&
                        observation.em_max != null
                    );

                    return representative ? (
                      <p>
                        Approximate band range:{" "}
                        <strong>
                          {formatWavelengthRange(
                            representative.em_min,
                            representative.em_max
                          )}
                        </strong>
                      </p>
                    ) : (
                      <p>Wavelength information unavailable.</p>
                    );
                  })()}

                  <p>
                    Loaded observations in this band:{" "}
                    <strong>{filteredObservations.length}</strong>
                  </p>
                </>
              )}
            </div>

            <p>
              These counts represent observations currently loaded
              in the app. Load more observations to expand the list.
            </p>
          </section>

          {filteredObservations.length > 0 && currentObservation && (
            <section>
              <h2>Observation Time Series</h2>

              <p>
                Observation {currentIndex + 1} of{" "}
                {filteredObservations.length}
              </p>

              <h3>{currentObservation.obs_id}</h3>

              <p>
                Band: {currentObservation.energy_bandpassname}
              </p>

              <p>
                Approximate band range:{" "}
                {formatWavelengthRange(
                  currentObservation.em_min,
                  currentObservation.em_max
                )}
              </p>

              <p>
                Observation date: {currentObservation.observation_date}
              </p>

              <details className="metadata-panel">
                <summary>View Observation Metadata</summary>

                <div className="metadata-grid">
                  {Object.entries(currentObservation)
                    .filter(([key, value]) =>
                      key !== "access_url" &&
                      value !== null &&
                      value !== undefined &&
                      value !== ""
                    )
                    .map(([key, value]) => (
                      <div className="metadata-item" key={key}>
                        <strong>
                          {key.replace(/_/g, " ")}
                        </strong>
                        <span>{String(value)}</span>
                      </div>
                    ))}
                </div>
              </details>

              <ZoomableImage
                key={currentObservation.access_url}
                src={displayedImageSrc}
                alt={
                  gaiaOverlayIsVisible
                    ? "SPHEREx observation with Gaia DR3 catalog positions"
                    : "Current SPHEREx observation"
                }
                style={{
                  width: "100%",
                  maxWidth: "700px",
                  margin: "20px auto"
                }}
              />

              <section className="spectral-measurement">
                <h3>Wavelength at Search Position</h3>

                <p>
                  The wavelength varies across a SPHEREx detector.
                  Measure it at the pixel corresponding to your searched
                  RA and DEC.
                </p>

                <button
                  onClick={handleGetSpectralInfo}
                  disabled={loadingSpectralInfo}
                >
                  {loadingSpectralInfo
                    ? "Calculating wavelength..."
                    : "Measure Wavelength at Search Position"}
                </button>

                {spectralInfo && (
                  <div className="spectral-info-results">
                    <p>
                      <strong>Central wavelength:</strong>{" "}
                      <strong>
                        {spectralInfo.wavelength_um.toFixed(6)} µm
                      </strong>
                    </p>

                    <p>
                      <strong>Bandwidth:</strong>{" "}
                      <strong>
                        {spectralInfo.bandwidth_um.toFixed(6)} µm
                      </strong>
                    </p>

                    <p>
                      Approximate wavelength interval:{" "}
                      {spectralInfo.wavelength_min_um.toFixed(6)}
                      {" – "}
                      {spectralInfo.wavelength_max_um.toFixed(6)} µm
                    </p>

                    <p>
                      Detector: {spectralInfo.detector}
                    </p>

                    <p>
                      Image pixel: (
                      {spectralInfo.pixel_x.toFixed(2)},{" "}
                      {spectralInfo.pixel_y.toFixed(2)})
                    </p>

                    <p>
                      Searched position: RA {spectralInfo.ra}°,
                      DEC {spectralInfo.dec}°
                    </p>

                    <div
                      style={{
                        position: "relative",
                        width: "100%",
                        height: "18px",
                        margin: "18px 0 8px",
                        borderRadius: "5px",
                        background:
                          "linear-gradient(to right, violet, blue, cyan, green, yellow, orange, red)"
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          left: `${wavelengthMarkerPosition}%`,
                          top: "-5px",
                          width: "3px",
                          height: "28px",
                          background: "black",
                          border: "1px solid white",
                          transform: "translateX(-50%)"
                        }}
                      />
                    </div>

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between"
                      }}
                    >
                      <span>0.75 µm</span>
                      <span>5.00 µm</span>
                    </div>

                    <p>
                      The marker shows the measured central wavelength
                      on the nominal SPHEREx wavelength scale.
                    </p>
                  </div>
                )}
              </section>

              <div>
                <button
                  onClick={goToPrevious}
                  disabled={filteredObservations.length < 2}
                >
                  Previous
                </button>

                <button
                  onClick={() => setIsPlaying(!isPlaying)}
                  disabled={filteredObservations.length < 2}
                >
                  {isPlaying ? "Pause" : "Play"}
                </button>

                <button
                  onClick={goToNext}
                  disabled={filteredObservations.length < 2}
                >
                  Next
                </button>
              </div>

              <p>
                Each observation displays for at least 1.5 seconds.
                Playback may wait longer for images to load.
              </p>

              <button
                onClick={() => {
                  setSelectedUrl(currentObservation.access_url);
                  setAnalysisResult(null);
                }}
              >
                Use as First Comparison Image
              </button>

              <button
                onClick={() => {
                  setSelectedUrl2(currentObservation.access_url);
                  setAnalysisResult(null);
                }}
              >
                Use as Second Comparison Image
              </button>
            </section>
          )}

          {filteredObservations.length === 0 && (
            <p>
              No observations are currently loaded for this band.
              Try another band or load more observations.
            </p>
          )}

          {result.has_more && (
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading..." : "Load More Observations"}
            </button>
          )}

          <hr />

          <h2>Compare Two Observations</h2>

          <p>
            The comparison selectors use the currently selected band.
          </p>

          <h3>First Observation</h3>

          <select
            value={selectedUrl}
            onChange={(event) => {
              setSelectedUrl(event.target.value);
              setAnalysisResult(null);
            }}
          >
            <option value="">Choose an observation</option>

            {filteredObservations.map((observation, index) => (
              <option
                key={observation.access_url || index}
                value={observation.access_url}
              >
                {observation.obs_id} — {observation.energy_bandpassname} — {observation.observation_date}
              </option>
            ))}
          </select>

          <h3>Second Observation</h3>

          <select
            value={selectedUrl2}
            onChange={(event) => {
              setSelectedUrl2(event.target.value);
              setAnalysisResult(null);
            }}
          >
            <option value="">Choose an observation</option>

            {filteredObservations.map((observation, index) => (
              <option
                key={observation.access_url || index}
                value={observation.access_url}
              >
                {observation.obs_id} — {observation.energy_bandpassname} — {observation.observation_date}
              </option>
            ))}
          </select>

          {selectedUrl && (
            <div>
              <h3>First Comparison Image</h3>

              <ZoomableImage
                key={selectedUrl}
                src={`${API_URL}/image?url=${encodeURIComponent(selectedUrl)}`}
                alt="First SPHEREx observation"
                style={{
                  width: "100%",
                  maxWidth: "600px",
                  margin: "20px auto"
                }}
              />
            </div>
          )}

          {selectedUrl2 && (
            <div>
              <h3>Second Comparison Image</h3>

              <ZoomableImage
                key={selectedUrl2}
                src={`${API_URL}/image?url=${encodeURIComponent(selectedUrl2)}`}
                alt="Second SPHEREx observation"
                style={{
                  width: "100%",
                  maxWidth: "600px",
                  margin: "20px auto"
                }}
              />
            </div>
          )}

          {selectedUrl && selectedUrl2 && (
            <button
              onClick={handleAnalyze}
              disabled={loadingAnalysis || selectedUrl === selectedUrl2}
            >
              {loadingAnalysis ? "Analyzing..." : "Analyze Observations"}
            </button>
          )}

          {analysisResult && (
            <div className="analysis-results">
              <h2>Analysis Results</h2>

              <p>Overlapping pixels: {analysisResult.overlap_pixels}</p>
              <p>Median offset: {analysisResult.median_offset}</p>
              <p>Mean difference: {analysisResult.mean_difference}</p>
              <p>Median difference: {analysisResult.median_difference}</p>
              <p>Standard deviation: {analysisResult.std_difference}</p>
              <p>Positive candidate pixels: {analysisResult.positive_candidate_pixels}</p>
              <p>Negative candidate pixels: {analysisResult.negative_candidate_pixels}</p>

              <h3>Difference Image</h3>

              <p>
                Highlighted regions show pixels with unusually large differences.
                These are candidate changes, not confirmed moving objects.
              </p>

              {analysisResult.difference_image && (
                <ZoomableImage
                  key={analysisResult.difference_image}
                  src={`data:image/png;base64,${analysisResult.difference_image}`}
                  alt="SPHEREx difference image with candidate changes highlighted"
                  style={{
                    width: "100%",
                    maxWidth: "700px",
                    margin: "20px auto"
                  }}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
