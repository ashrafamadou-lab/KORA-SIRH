import { Injectable, Logger } from '@nestjs/common';
import { hibpDigest } from '../../../../packages/core/src/password-policy.ts';

/**
 * Vérification des mots de passe compromis — trois modes (KORA_BREACH_CHECK) :
 *   'off'   : désactivée (dev/test par défaut).
 *   'local' : liste embarquée dans @kora/core (checkPassword) — sans réseau, toujours
 *             disponible ; ce service renvoie alors false (pas de vérif distante en plus).
 *   'hibp'  : API HIBP par k-anonymat (préfixe SHA-1 de 5 ; le mot de passe ne sort jamais).
 *
 * Comportement en cas d'INDISPONIBILITÉ du service distant (mode 'hibp') — décision de
 * conception explicite et testable via KORA_BREACH_FAIL :
 *   'open'  (défaut) : on n'a pas pu prouver la compromission → on n'ajoute pas d'obstacle
 *             (la politique locale de @kora/core reste, elle, toujours appliquée en amont).
 *   'closed': on refuse le mot de passe (503) — posture durcie où l'absence de preuve
 *             d'innocuité vaut refus. À réserver aux tenants à exigence forte.
 * L'appelant DOIT toujours appliquer checkPassword (politique locale) AVANT ce service :
 * la disponibilité de HIBP ne conditionne que la couche distante, jamais la base.
 */
export type BreachOutcome =
  | { status: 'ok' }          // vérifié disponible : non compromis
  | { status: 'breached' }    // vérifié : compromis (à refuser)
  | { status: 'unavailable' }; // service injoignable — l'appelant applique la politique fail

export interface BreachHttp {
  (url: string, init: { signal: AbortSignal; headers: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }>;
}

@Injectable()
export class BreachedPasswordService {
  private readonly logger = new Logger(BreachedPasswordService.name);
  private readonly mode = (process.env.KORA_BREACH_CHECK ?? 'off').toLowerCase();
  readonly failMode = (process.env.KORA_BREACH_FAIL ?? 'open').toLowerCase() === 'closed'
    ? 'closed'
    : 'open';

  /** Transport HTTP surchargéable en test via setHttp() ; défaut = fetch global. */
  private http: BreachHttp = defaultHttp;

  setHttp(http: BreachHttp): void {
    this.http = http;
  }

  get enabled(): boolean {
    return this.mode === 'hibp';
  }

  async check(password: string): Promise<BreachOutcome> {
    if (this.mode !== 'hibp') return { status: 'ok' }; // 'off'/'local' : rien à faire ici
    const { prefix, suffix } = hibpDigest(password);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const res = await this.http(`https://api.pwnedpasswords.com/range/${prefix}`, {
        signal: controller.signal,
        headers: { 'Add-Padding': 'true', 'User-Agent': 'KORA-SIRH' },
      });
      if (!res.ok) {
        this.logger.warn(`HIBP a répondu ${res.status} — traité comme indisponible`);
        return { status: 'unavailable' };
      }
      const body = await res.text();
      const breached = body
        .split('\n')
        .some((line) => line.split(':')[0]?.trim().toUpperCase() === suffix);
      return { status: breached ? 'breached' : 'ok' };
    } catch (err) {
      this.logger.warn(`HIBP injoignable (${(err as Error).name}) — service indisponible`);
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timeout);
    }
  }
}

const defaultHttp: BreachHttp = (url, init) =>
  fetch(url, init) as unknown as ReturnType<BreachHttp>;
