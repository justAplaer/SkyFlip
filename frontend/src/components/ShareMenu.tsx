import { shareUrl, type UrlState } from "../lib/urlState";

/** Copy share link + embed + export candidates. */
export function ShareMenu({
  state,
  onExportCandidates,
  canExport,
}: {
  state: UrlState;
  onExportCandidates: () => void;
  canExport: boolean;
}) {
  return (
    <details className="toolbar-menu">
      <summary>Share</summary>
      <div className="toolbar-menu-body" role="group" aria-label="Share actions">
        <button
          type="button"
          data-testid="copy-share-link"
          onClick={async () => {
            const url = shareUrl(state);
            await navigator.clipboard.writeText(url);
            alert("Link copied.");
          }}
        >
          Copy share link
        </button>
        <button
          type="button"
          data-testid="copy-embed-code"
          onClick={async () => {
            const url = shareUrl({ ...state, embed: true });
            const snippet = `<iframe src="${url}" title="SkyFlip" width="800" height="600" loading="lazy" style="border:0;max-width:100%"></iframe>`;
            await navigator.clipboard.writeText(snippet);
            alert("Embed iframe code copied (?embed=1).");
          }}
        >
          Copy embed code
        </button>
        <button
          type="button"
          data-testid="cite-this-view"
          onClick={async () => {
            const url = shareUrl(state);
            const cite = `SkyFlip SPHEREx blink view (${new Date().toISOString().slice(0, 10)}). Data: NASA/JPL-Caltech/IPAC SPHEREx via IRSA. ${url}`;
            await navigator.clipboard.writeText(cite);
            alert("Citation copied.");
          }}
        >
          Cite this view
        </button>
        <button type="button" disabled={!canExport} onClick={onExportCandidates}>
          Export candidates JSON
        </button>
      </div>
    </details>
  );
}
