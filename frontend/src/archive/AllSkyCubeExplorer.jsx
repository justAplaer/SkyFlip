
import { useEffect, useState } from "react";
import "./AllSkyCubeExplorer.css";

const API_URL = `${import.meta.env.VITE_API_URL ?? ""}/api/archive`;

function AllSkyCubeExplorer() {
  const [ra, setRA] = useState("");
  const [dec, setDEC] = useState("");
  const [radius, setRadius] = useState("0.01");

  const [cubeResult, setCubeResult] = useState(null);
  const [selectedTileIndex, setSelectedTileIndex] = useState(0);
  const [channel, setChannel] = useState(1);

  const [searching, setSearching] = useState(false);
  const [channelLoading, setChannelLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [imageError, setImageError] = useState("");

  const [imageSrc, setImageSrc] = useState("");
  const [channelMetadata, setChannelMetadata] = useState(null);

  const selectedTile = cubeResult?.tiles?.[selectedTileIndex];

  async function handleSearch(event) {
    event.preventDefault();

    const raValue = Number(ra);
    const decValue = Number(dec);
    const radiusValue = Number(radius);

    if (!Number.isFinite(raValue) || raValue < 0 || raValue > 360) {
      setSearchError("RA must be between 0 and 360 degrees.");
      return;
    }

    if (!Number.isFinite(decValue) || decValue < -90 || decValue > 90) {
      setSearchError("DEC must be between -90 and 90 degrees.");
      return;
    }

    if (
      !Number.isFinite(radiusValue) ||
      radiusValue <= 0 ||
      radiusValue > 1
    ) {
      setSearchError("Radius must be greater than 0 and no more than 1 degree.");
      return;
    }

    try {
      setSearching(true);
      setSearchError("");
      setImageError("");
      setCubeResult(null);
      setImageSrc("");
      setChannelMetadata(null);

      const params = new URLSearchParams({
        ra: String(raValue),
        dec: String(decValue),
        radius: String(radiusValue)
      });

      const response = await fetch(
        `${API_URL}/cube-search?${params.toString()}`
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Cube search failed.");
      }

      setCubeResult(data);
      setSelectedTileIndex(0);
      setChannel(1);
    } catch (error) {
      setSearchError(error.message || "Unable to search All-Sky Cube data.");
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    if (!selectedTile?.access_url) {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    async function loadChannel() {
      try {
        setChannelLoading(true);
        setImageError("");
        setImageSrc("");
        setChannelMetadata(null);

        const params = new URLSearchParams({
          access_url: selectedTile.access_url,
          channel: String(channel)
        });

        const response = await fetch(
          `${API_URL}/cube-channel?${params.toString()}`,
          { signal: controller.signal }
        );

        if (!response.ok) {
          let message = `Unable to load channel ${channel}.`;

          try {
            const data = await response.json();
            message = data.detail || message;
          } catch {
            // Keep the fallback message.
          }

          throw new Error(message);
        }

        const blob = await response.blob();

        if (cancelled) return;

        const nextImageUrl = URL.createObjectURL(blob);

        setImageSrc(nextImageUrl);

        setChannelMetadata({
          channel: Number(response.headers.get("X-Cube-Channel")),
          wavelength: Number(
            response.headers.get("X-Cube-Wavelength-Um")
          ),
          bandwidth: Number(
            response.headers.get("X-Cube-Bandwidth-Um")
          ),
          detector: Number(
            response.headers.get("X-Cube-Detector")
          ),
          subchannel: Number(
            response.headers.get("X-Cube-Subchannel")
          ),
          unit: response.headers.get("X-Cube-Bunit")
        });
      } catch (error) {
        if (error.name !== "AbortError" && !cancelled) {
          setImageError(error.message || "Unable to render this channel.");
        }
      } finally {
        if (!cancelled) {
          setChannelLoading(false);
        }
      }
    }

    loadChannel();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedTile?.access_url, channel]);

  // Release old browser image URLs when a new image replaces them.
  useEffect(() => {
    return () => {
      if (imageSrc) {
        URL.revokeObjectURL(imageSrc);
      }
    };
  }, [imageSrc]);

  function selectTile(event) {
    setSelectedTileIndex(Number(event.target.value));
    setChannel(1);
    setImageError("");
  }

  function goToPreviousChannel() {
    setChannel((current) => Math.max(1, current - 1));
  }

  function goToNextChannel() {
    setChannel((current) => Math.min(102, current + 1));
  }

  return (
    <section className="cube-explorer">
      <div className="cube-heading">
        <span className="cube-eyebrow">SPHEREx DR1 DATA</span>
        <h2>All-Sky Cube Explorer</h2>
        <p>
          Explore the same region of the sky across 102 infrared
          spectral channels.
        </p>
      </div>

      <form className="cube-search-form" onSubmit={handleSearch}>
        <div className="cube-coordinate-grid">
          <div>
            <label htmlFor="cube-ra">Right Ascension (RA)</label>
            <input
              id="cube-ra"
              type="number"
              min="0"
              max="360"
              step="any"
              value={ra}
              onChange={(event) => setRA(event.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="cube-dec">Declination (DEC)</label>
            <input
              id="cube-dec"
              type="number"
              min="-90"
              max="90"
              step="any"
              value={dec}
              onChange={(event) => setDEC(event.target.value)}
              required
            />
          </div>

          <div>
            <label htmlFor="cube-radius">Search radius (degrees)</label>
            <input
              id="cube-radius"
              type="number"
              min="0.0001"
              max="1"
              step="any"
              value={radius}
              onChange={(event) => setRadius(event.target.value)}
              required
            />
          </div>
        </div>

        <button type="submit" disabled={searching}>
          {searching ? "Searching cube tiles..." : "Search All-Sky Cube"}
        </button>
      </form>

      {searchError && (
        <p className="cube-error" role="alert">{searchError}</p>
      )}

      {cubeResult && (
        <div className="cube-results">
          <div className="cube-result-summary">
            <h3>Cube Search Results</h3>
            <p>
              Found <strong>{cubeResult.tiles_found}</strong> tile(s)
              for RA {cubeResult.ra}°, DEC {cubeResult.dec}°.
            </p>
          </div>

          {cubeResult.tiles_found > 0 ? (
            <>
              {cubeResult.tiles.length > 1 && (
                <div className="cube-tile-selector">
                  <label htmlFor="cube-tile">Select cube tile</label>
                  <select
                    id="cube-tile"
                    value={selectedTileIndex}
                    onChange={selectTile}
                  >
                    {cubeResult.tiles.map((tile, index) => (
                      <option key={tile.obs_id} value={index}>
                        {tile.obs_id}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {selectedTile && (
                <>
                  <div className="cube-tile-info">
                    <span>Selected tile</span>
                    <strong>{selectedTile.obs_id}</strong>
                    <span>
                      Coverage: {selectedTile.s_fov}°
                    </span>
                  </div>

                  <div className="cube-channel-panel">
                    <div className="cube-channel-heading">
                      <div>
                        <h3>Spectral Channel</h3>
                        <p>Select a wavelength plane to view.</p>
                      </div>

                      <strong className="cube-channel-number">
                        {channel} / 102
                      </strong>
                    </div>

                    <input
                      className="cube-channel-slider"
                      type="range"
                      min="1"
                      max="102"
                      step="1"
                      value={channel}
                      onChange={(event) =>
                        setChannel(Number(event.target.value))
                      }
                      aria-label="Spectral channel"
                    />

                    <div className="cube-slider-labels">
                      <span>Channel 1</span>
                      <span>Channel 102</span>
                    </div>

                    <div className="cube-channel-buttons">
                      <button
                        type="button"
                        onClick={goToPreviousChannel}
                        disabled={channel === 1 || channelLoading}
                      >
                        Previous
                      </button>

                      <button
                        type="button"
                        onClick={goToNextChannel}
                        disabled={channel === 102 || channelLoading}
                      >
                        Next
                      </button>
                    </div>

                    {channelLoading && (
                      <p className="cube-loading" role="status">
                        Loading channel {channel}...
                      </p>
                    )}

                    {imageError && (
                      <p className="cube-error" role="alert">
                        {imageError}
                      </p>
                    )}

                    {channelMetadata && (
                      <div className="cube-metadata-grid">
                        <div>
                          <span>Wavelength</span>
                          <strong>
                            {channelMetadata.wavelength.toFixed(3)} μm
                          </strong>
                        </div>

                        <div>
                          <span>Bandwidth</span>
                          <strong>
                            {channelMetadata.bandwidth.toFixed(3)} μm
                          </strong>
                        </div>

                        <div>
                          <span>Detector</span>
                          <strong>{channelMetadata.detector}</strong>
                        </div>

                        <div>
                          <span>Subchannel</span>
                          <strong>{channelMetadata.subchannel}</strong>
                        </div>

                        <div>
                          <span>Image units</span>
                          <strong>{channelMetadata.unit}</strong>
                        </div>
                      </div>
                    )}

                    {imageSrc && (
                      <div className="cube-image-container">
                        <img
                          src={imageSrc}
                          alt={`SPHEREx All-Sky Cube channel ${channel}`}
                        />
                      </div>
                    )}

                    <p className="cube-data-note">
                      Channels 51 and 52 are documented as having no
                      data. An unavailable channel is not a zero-valued
                      scientific measurement.
                    </p>
                  </div>
                </>
              )}
            </>
          ) : (
            <p>No All-Sky Cube tiles were found at these coordinates.</p>
          )}
        </div>
      )}
    </section>
  );
}

export default AllSkyCubeExplorer;
