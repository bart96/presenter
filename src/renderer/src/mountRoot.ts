import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';

import { showDevBanner } from './devBanner';

/**
 * Mount a page entry — once per container, however many times this module runs.
 *
 * Every entry used to end in a bare `createRoot(...).render(...)`, which is correct
 * exactly once. Vite re-executes an entry whenever a hot update's dependency chain
 * reaches it, and a second `createRoot` on the same element does not replace the first:
 * both roots stay alive and render independently over one DOM node.
 *
 * That is worse than a duplicate. The two roots own overlapping component trees, so an
 * update scheduled by one lands while the other is rendering — which React reports as
 * "cannot update a component while rendering a different component", naming whichever
 * pair it happened to catch rather than anything actually at fault. It sent an afternoon
 * hunting a render-phase dispatch in `MusicianPage` that does not exist. It also blanks
 * the page outright when the two roots disagree about what is mounted.
 *
 * Caching the root on the container turns a re-run back into a re-render, which is what
 * was meant by it. Nothing changes in a production build, where an entry runs once.
 *
 * This is also where the dev-deployment banner is raised, so that a new page cannot be
 * added without one. The presentation window mounts its own root and asks for it itself.
 */
const ROOT = Symbol.for('presenter.root');

type RootHolder = HTMLElement & { [ROOT]?: Root };

export const mountRoot = (node: ReactNode, containerId = 'root'): Root => {
  const container = document.getElementById(containerId) as RootHolder | null;
  if (!container) throw new Error(`mountRoot: no #${containerId} element to mount into.`);

  const root = container[ROOT] ?? createRoot(container);
  container[ROOT] = root;
  root.render(node);
  void showDevBanner();
  return root;
};
