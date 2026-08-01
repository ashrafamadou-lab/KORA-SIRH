/**
 * Internationalisation (E7) — FR par défaut, EN complet, extensible.
 *  - Aucune chaîne visible en dur dans les composants : tout passe par t().
 *  - Les dictionnaires sont TYPÉS (mêmes clés exigées à la compilation).
 *  - La préférence est persistée CÔTÉ SERVEUR (PUT /notifications/preferences.locale,
 *    colonne users.locale de E5) ; un miroir local non sensible sert uniquement à
 *    afficher l'écran de connexion dans la dernière langue choisie.
 *  - Les paramètres {x} sont interpolés avec des valeurs passées par le code — jamais
 *    de HTML : l'insertion se fait toujours via textContent (anti-XSS).
 */
import { fr, type Dict, type MessageKey } from '../i18n/fr.ts';
import { en } from '../i18n/en.ts';

export type Locale = 'fr' | 'en';
export const SUPPORTED_LOCALES: readonly Locale[] = ['fr', 'en'];
export const DEFAULT_LOCALE: Locale = 'fr';

const DICTS: Record<Locale, Dict> = { fr, en };
/** Clé de préférence d'AFFICHAGE (non sensible) — jamais un jeton ni une donnée RH. */
const LOCALE_MIRROR_KEY = 'kora.locale';

let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

export function isLocale(v: unknown): v is Locale {
  return v === 'fr' || v === 'en';
}

/** Initialisation au démarrage : miroir local s'il existe, sinon français. */
export function initLocale(): Locale {
  try {
    const mirror = globalThis.localStorage?.getItem(LOCALE_MIRROR_KEY);
    if (isLocale(mirror)) current = mirror;
  } catch {
    /* stockage indisponible (navigation privée stricte) : français par défaut */
  }
  return current;
}

export function getLocale(): Locale {
  return current;
}

/** Change la langue APPLICATIVE (rendu + miroir local). La persistance serveur est faite par l'appelant authentifié. */
export function setLocale(locale: Locale): void {
  if (current === locale) return;
  current = locale;
  try {
    globalThis.localStorage?.setItem(LOCALE_MIRROR_KEY, locale);
  } catch {
    /* non bloquant */
  }
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  for (const fn of listeners) fn();
}

export function onLocaleChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Traduction : clé typée + interpolation {param}. Repli défensif sur le français. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = DICTS[current][key] ?? fr[key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined ? whole : String(v);
  });
}

/** Toutes les clés (pour les tests de complétude et d'absence de clé brute). */
export function allMessageKeys(): MessageKey[] {
  return Object.keys(fr) as MessageKey[];
}

export function dictFor(locale: Locale): Dict {
  return DICTS[locale];
}

export type { MessageKey };
