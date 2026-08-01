/**
 * Session (clôture Phase 1) — AUCUN jeton côté client.
 *
 *  - Le jeton de session vit dans un cookie HttpOnly posé par le SERVEUR
 *    (SameSite=Strict, Path=/api, Secure en production) : le JavaScript du navigateur
 *    ne peut pas le lire, et RIEN n'est écrit dans localStorage, sessionStorage ni
 *    IndexedDB.
 *  - Seul le jeton CSRF (dérivé HMAC côté serveur — pas un secret de session) est
 *    gardé EN MÉMOIRE et rechargé via /auth/me au démarrage d'onglet.
 *  - purge() efface profil et CSRF en mémoire et prévient les abonnés — déclenchée à
 *    la déconnexion ET sur tout 401 (révocation, désactivation : rejet IMMÉDIAT).
 *  - Le tenant est résolu par le SERVEUR au login (slug) ; le client n'envoie jamais
 *    de tenant_id.
 */
import { ApiClient, ApiError, type LoginResponse, type MeResponse } from './api.ts';
import { isLocale, setLocale } from './i18n.ts';

export type LoginStep =
  | { kind: 'ok' }
  | { kind: 'mfa_required' }
  | { kind: 'invalid' }
  | { kind: 'locked'; retryAfterSeconds: number | null }
  | { kind: 'rate_limited'; retryAfterSeconds: number | null }
  | { kind: 'unavailable' }
  | { kind: 'offline' };

export class Session {
  readonly api: ApiClient;
  private profile: MeResponse | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(api: ApiClient) {
    this.api = api;
  }

  // ---------- état ----------

  get me(): MeResponse | null {
    return this.profile;
  }
  isAuthenticated(): boolean {
    return this.profile !== null;
  }
  hasPermission(key: string): boolean {
    return this.profile?.permissions.includes(key) ?? false;
  }
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // ---------- cycle de vie ----------

  /**
   * Reprise d'onglet : si le cookie HttpOnly est encore valable, /auth/me répond et
   * fournit le jeton CSRF à recharger en mémoire — aucune confiance locale.
   */
  async resume(): Promise<boolean> {
    try {
      const me = await this.api.call<MeResponse>('me', { expectAuthErrors: true });
      this.adopt(me);
      return true;
    } catch {
      this.purge();
      return false;
    }
  }

  async login(tenantSlug: string, email: string, password: string, mfaCode?: string): Promise<LoginStep> {
    try {
      // Transport COOKIE : le serveur pose le cookie HttpOnly ; la réponse ne
      // contient JAMAIS le jeton de session — uniquement le CSRF dérivé.
      const res = await this.api.call<LoginResponse>('login', {
        body: { tenantSlug, email, password, tokenTransport: 'cookie', ...(mfaCode ? { mfaCode } : {}) },
        expectAuthErrors: true,
      });
      this.api.setCsrf(res.csrfToken);
      const me = await this.api.call<MeResponse>('me');
      this.adopt(me);
      return { kind: 'ok' };
    } catch (e) {
      if (!(e instanceof ApiError)) return { kind: 'unavailable' };
      if (e.kind === 'unauthorized') {
        return e.code === 'mfa_required' ? { kind: 'mfa_required' } : { kind: 'invalid' };
      }
      if (e.kind === 'locked') return { kind: 'locked', retryAfterSeconds: e.retryAfterSeconds };
      if (e.kind === 'rate_limited') return { kind: 'rate_limited', retryAfterSeconds: e.retryAfterSeconds };
      if (e.kind === 'offline') return { kind: 'offline' };
      return { kind: 'unavailable' };
    }
  }

  private adopt(me: MeResponse): void {
    this.profile = me;
    if (typeof me.csrfToken === 'string') this.api.setCsrf(me.csrfToken);
    if (isLocale(me.locale)) setLocale(me.locale);
    this.emit();
  }

  async logout(): Promise<void> {
    try {
      // Révoque la session côté serveur ET efface le cookie (Set-Cookie Max-Age=0).
      if (this.profile) await this.api.call<void>('logout', { expectAuthErrors: true });
    } catch {
      /* la purge locale a lieu quoi qu'il arrive */
    }
    this.purge();
  }

  /** Efface TOUT état local de session (mémoire uniquement — rien n'est stocké). */
  purge(): void {
    this.profile = null;
    this.api.setCsrf(null);
    this.emit();
  }

  /** Recharge le profil (après changement de rôle/langue côté serveur). */
  async refreshProfile(): Promise<void> {
    if (!this.profile) return;
    const me = await this.api.call<MeResponse>('me');
    this.adopt(me);
  }

  /** Persiste la langue côté serveur (préférence utilisateur) + application immédiate. */
  async persistLocale(locale: 'fr' | 'en'): Promise<void> {
    setLocale(locale);
    if (!this.isAuthenticated()) return;
    try {
      await this.api.call<unknown>('notifyPreferences', { body: { locale } });
      if (this.profile) this.profile = { ...this.profile, locale };
    } catch {
      /* la langue d'affichage reste appliquée ; la persistance réessaiera plus tard */
    }
  }
}
