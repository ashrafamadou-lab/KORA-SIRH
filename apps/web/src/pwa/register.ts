/**
 * Enregistrement du service worker + détection de nouvelle version.
 * Quand un worker mis à jour est PRÊT, l'application propose le rechargement
 * (bandeau) — jamais de rechargement forcé pendant une saisie.
 */
export interface UpdateHandle {
  onUpdateReady(fn: () => void): void;
  applyUpdate(): void;
}

export function registerServiceWorker(): UpdateHandle {
  let updateReadyCb: (() => void) | null = null;
  let waiting: ServiceWorker | null = null;

  const handle: UpdateHandle = {
    onUpdateReady(fn) {
      updateReadyCb = fn;
      if (waiting) fn();
    },
    applyUpdate() {
      waiting?.postMessage({ type: 'SKIP_WAITING' });
      // Rechargement quand le nouveau worker prend la main.
      navigator.serviceWorker?.addEventListener('controllerchange', () => location.reload(), { once: true });
    },
  };

  if (!('serviceWorker' in navigator)) return handle;
  // sw.js est assemblé au build en UN SEUL fichier classique (compatibilité maximale).
  void navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      if (reg.waiting) {
        waiting = reg.waiting;
        updateReadyCb?.();
      }
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            waiting = reg.waiting;
            updateReadyCb?.();
          }
        });
      });
    })
    .catch(() => {
      /* PWA dégradée sans SW : l'application reste fonctionnelle en ligne */
    });
  return handle;
}
