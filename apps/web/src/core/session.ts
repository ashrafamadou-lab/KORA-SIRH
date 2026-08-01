/**
 * Session (E7) — un seul endroit qui touche au jeton.
 *
 *  - Jeton opaque k1.* en MÉMOIRE + sessionStorage D'ONGLET (survit au rechargement,
 *    meurt avec l'onglet) — JAMAIS localStorage, JAMAIS IndexedDB, JAMAIS cookie posé
 *    par le client. Compromis documenté : la CSP stricte et le rendu textContent
 *    réduisent la surface XSS ; la session côté cookie httpOnly est une évolution
 *    serveur planifiée.
 *  - purge() efface jeton ET profil en mémoire, le miroir d'onglet, et prévient les
 *    abonnés — appelée à la déconnexion ET sur tout 401 (révocation, désactivation).
 *  - Le tenant est résolu par le SERVEUR au login (slug) puis porté par la session ;
 *    le client n'envoie jamais de tenant_id.
 */
import { ApiClient, ApiError, type LoginResponse, type MeResponse } from './api.ts';
import { isLocale, setLocale } from './i18n.ts';

const TOKEN_TAB_KEY = 'kora.session';

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

  /** Reprise d'onglet : jeton du sessionStorage revalidé par /auth/me (jamais de confiance locale). */
  async resume(): Promise<boolean> {
    let token: string | null = null;
    try {
      token = globalThis.sessionStorage?.getItem(TOKEN_TAB_KEY) ?? null;
    } catch {
      token = null;
    }
    if (!token) return false;
    this.api.setToken(token);
    try {
      this.profile = await this.api.call<MeResponse>('me', { expectAuthErrors: true });
      if (isLocale(this.profile.locale)) setLocale(this.profile.locale);
      this.emit();
      return true;
    } catch {
      this.purge();
      return false;
    }
  }

  async login(tenantSlug: string, email: string, password: string, mfaCode?: string): Promise<LoginStep> {
    try {
      const res = await this.api.call<LoginResponse>('login', {
        body: { tenantSlug, email, password, ...(mfaCode ? { mfaCode } : {}) },
        expectAuthErrors: true,
      });
      this.api.setToken(res.token);
      try {
        globalThis.sessionStorage?.setItem(TOKEN_TAB_KEY, res.token);
      } catch {
        /* mémoire seule : acceptable */
      }
      this.profile = await this.api.call<MeResponse>('me');
      if (isLocale(this.profile.locale)) setLocale(this.profile.locale);
      this.emit();
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

  async logout(): Promise<void> {
    try {
      if (this.api.hasToken()) await this.api.call<void>('logout', { expectAuthErrors: true });
    } catch {
      /* la purge locale a lieu quoi qu'il arrive */
    }
    this.purge();
  }

  /** Efface TOUT état local de session (déconnexion, 401, désactivation). */
  purge(): void {
    this.profile = null;
    this.api.setToken(null);
    try {
      globalThis.sessionStorage?.removeItem(TOKEN_TAB_KEY);
    } catch {
      /* rien à faire */
    }
    this.emit();
  }

  /** Recharge le profil (après changement de rôle/langue côté serveur). */
  async refreshProfile(): Promise<void> {
    if (!this.api.hasToken()) return;
    this.profile = await this.api.call<MeResponse>('me');
    this.emit();
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
