import { useEffect, useRef, useState } from "react";

/** Pinned Aladin Lite build — never use "latest" in production demos. */
const ALADIN_JS =
  "https://aladin.cds.unistra.fr/AladinLite/api/v3/3.4.0/aladin.js";
const ALADIN_CSS =
  "https://aladin.cds.unistra.fr/AladinLite/api/v3/3.4.0/aladin.css";

declare global {
  interface Window {
    A?: {
      aladin: (el: HTMLElement, opts: Record<string, unknown>) => AladinInstance;
    };
  }
}

interface AladinInstance {
  gotoRaDec: (ra: number, dec: number) => void;
  setFov: (fovDeg: number) => void;
}

export function AladinOverlay({ ra, dec, fov }: { ra: number; dec: number; fov: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const aladinRef = useRef<AladinInstance | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (!navigator.onLine) {
      setOffline(true);
      return;
    }
    const existing = document.querySelector("script[data-aladin]");
    const start = () => {
      if (!ref.current || !window.A) return;
      try {
        aladinRef.current = window.A.aladin(ref.current, {
          survey: "P/DSS2/color",
          fov,
          target: `${ra} ${dec}`,
          showReticle: true,
        });
        setOffline(false);
      } catch {
        setOffline(true);
      }
    };
    if (!document.querySelector("link[data-aladin-css]")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = ALADIN_CSS;
      link.dataset.aladinCss = "1";
      document.head.appendChild(link);
    }
    if (window.A) start();
    else if (!existing) {
      const s = document.createElement("script");
      s.src = ALADIN_JS;
      s.dataset.aladin = "1";
      s.onload = start;
      s.onerror = () => setOffline(true);
      document.body.appendChild(s);
    }
  }, []);

  useEffect(() => {
    aladinRef.current?.gotoRaDec(ra, dec);
    aladinRef.current?.setFov(fov);
  }, [ra, dec, fov]);

  return (
    <section className="panel" aria-label="Aladin sky context">
      <h2>Sky context (Aladin Lite v3.4.0)</h2>
      <p className="hint">
        CDS Aladin Lite (pinned v3.4.0). Gaia/WISE catalog layers when online. Position/FOV sync with
        the blink player.
      </p>
      {offline ? (
        <p className="badge" role="status">
          Aladin unavailable offline — blink player still works from cached demo data.
        </p>
      ) : (
        <div ref={ref} className="aladin" style={{ height: 280, width: "100%" }} />
      )}
    </section>
  );
}
