/**
 * Formats localisés (E7) — dates, heures, nombres, pourcentages via Intl.
 * Les CODES métier transmis par l'API ne sont jamais altérés : seule la présentation
 * est localisée.
 */
import { getLocale } from './i18n.ts';

const INTL_LOCALE: Record<string, string> = { fr: 'fr-FR', en: 'en-GB' };

function intlLocale(): string {
  return INTL_LOCALE[getLocale()] ?? 'fr-FR';
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium' }).format(d);
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function fmtNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat(intlLocale()).format(n);
}

export function fmtPercent(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat(intlLocale(), { style: 'percent', maximumFractionDigits: 1 }).format(n / 100);
}

/** AAAA-MM-JJ pour les champs date (valeur API), indépendamment de la langue. */
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
