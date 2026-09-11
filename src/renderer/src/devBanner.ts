/**
 * "This is the dev deployment" banner.
 *
 * Painted on every page when the backend's config.php has `DEVELOPMENT = true`, so that a
 * window showing songs, a set list or a projection can never be mistaken for the live one.
 * The dev subdomain looks identical to production by design — same build, same data once
 * it has been copied across — and the address bar is the only thing that says otherwise.
 * On a projection window there is no address bar at all.
 *
 * Deliberately plain DOM rather than a React component:
 *
 *   - it has to appear on all six entry points, which do not share a provider tree — the
 *     login page has no store data, the presentation window has no MUI theme;
 *   - it has to appear even when the app itself fails to mount, which is exactly when
 *     knowing which deployment you are looking at matters most;
 *   - it must not be able to break the page it is warning about.
 *
 * `mountRoot()` calls this for every page that goes through it. The presentation window
 * mounts its own root and asks for the compact form.
 */
import { getBackendBaseUrl } from '@/api/base.api';

const ELEMENT_ID = 'presenter-dev-banner';

/** Amber on near-black: legible over both app themes and over projected content. */
const AMBER = '#f0a020';
const INK = '#1a1206';

type Options = {
  /**
   * Stripe only, no pill. Used by the presentation window, where the page IS the output —
   * a label sitting over the lyrics would be read as part of them.
   */
  compact?: boolean;
};

/** The deployment's own address, which is what actually distinguishes dev from live. */
const deploymentLabel = (): string => {
  const configured = getBackendBaseUrl();
  try {
    return configured ? new URL(configured).host : window.location.host;
  } catch {
    return configured || window.location.host;
  }
};

const render = ({ compact }: Options): void => {
  if (document.getElementById(ELEMENT_ID)) return;

  const banner = document.createElement('div');
  banner.id = ELEMENT_ID;
  // Nothing here may ever intercept a click, cover a control, or take layout space.
  banner.style.cssText = [
    'position:fixed',
    'inset:0 0 auto 0',
    'z-index:2147483647',
    'pointer-events:none',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
  ].join(';');

  // Hazard stripe. Read peripherally — you register it without looking at it.
  const stripe = document.createElement('div');
  stripe.style.cssText = [
    'width:100%',
    'height:4px',
    `background:repeating-linear-gradient(135deg, ${AMBER} 0 10px, ${INK} 10px 20px)`,
  ].join(';');
  banner.appendChild(stripe);

  if (!compact) {
    const pill = document.createElement('div');
    pill.textContent = `DEV · ${deploymentLabel()}`;
    pill.style.cssText = [
      `background:${AMBER}`,
      `color:${INK}`,
      'font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'letter-spacing:0.09em',
      'padding:4px 10px 5px',
      'border-radius:0 0 4px 4px',
      'box-shadow:0 1px 4px rgba(0,0,0,0.35)',
      'white-space:nowrap',
      'max-width:70vw',
      'overflow:hidden',
      'text-overflow:ellipsis',
    ].join(';');
    banner.appendChild(pill);
  }

  document.body.appendChild(banner);
  // Screen readers get it once, as a statement of context rather than an alert.
  banner.setAttribute('role', 'note');
  banner.setAttribute('aria-label', `Development deployment: ${deploymentLabel()}`);
};

/**
 * Ask the backend whether it is a dev deployment and, if so, paint the banner.
 *
 * Never throws and never rejects: an offline app, a backend that is not reachable yet, or
 * an older backend without the flag all mean "no banner", which is the safe answer — a
 * missing banner on a dev box is a smaller problem than a spurious one on the live box.
 */
export const showDevBanner = async (options: Options = {}): Promise<void> => {
  try {
    const base = getBackendBaseUrl();
    const response = await fetch(`${base ? `${base}/` : '/'}rest/Session`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return;

    const session = (await response.json()) as { settings?: { development?: boolean } };
    if (session?.settings?.development !== true) return;

    if (document.body) render(options);
    else document.addEventListener('DOMContentLoaded', () => render(options), { once: true });
  } catch {
    /* no answer, no banner */
  }
};
