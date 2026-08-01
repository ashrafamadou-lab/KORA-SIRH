/**
 * Politique de robustesse des mots de passe (US-E1-01/05) — configurable, sans réseau.
 * La liste de compromission embarquée est un socle minimal ; la vérification contre une
 * base étendue (type HIBP hors-ligne) est un raffinement prévu côté API.
 */
export interface PasswordPolicy {
  minLength: number;
  /** Nombre minimal de classes de caractères parmi : minuscules, majuscules, chiffres, symboles. */
  minCharClasses: number;
  denylist: ReadonlySet<string>;
}

export type PasswordIssue =
  | 'too_short'
  | 'not_enough_char_classes'
  | 'in_denylist'
  | 'contains_email_localpart';

export interface PasswordCheck {
  ok: boolean;
  issues: PasswordIssue[];
}

const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password', 'password1', 'passw0rd', 'motdepasse', 'motdepasse1', 'azerty', 'azerty123',
  'qwerty', 'qwerty123', '123456', '1234567', '12345678', '123456789', '1234567890',
  '111111', '000000', 'abc123', 'iloveyou', 'admin', 'administrateur', 'bienvenue',
  'bienvenue1', 'soleil', 'bonjour', 'salut123', 'letmein', 'welcome', 'monkey',
  'dragon', 'football', 'secret', 'kora', 'kora123', 'kora2026', 'sirh', 'sirh2026',
  'cotonou', 'benin', 'benin229', 'doudou', 'chouchou',
]);

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  minCharClasses: 3,
  denylist: COMMON_PASSWORDS,
};

export function checkPassword(
  password: string,
  context: { email?: string } = {},
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): PasswordCheck {
  const issues: PasswordIssue[] = [];

  if (password.length < policy.minLength) issues.push('too_short');

  let classes = 0;
  if (/[a-z]/.test(password)) classes++;
  if (/[A-Z]/.test(password)) classes++;
  if (/\d/.test(password)) classes++;
  if (/[^a-zA-Z0-9]/.test(password)) classes++;
  if (classes < policy.minCharClasses) issues.push('not_enough_char_classes');

  const normalized = password.toLowerCase().trim();
  if (policy.denylist.has(normalized)) issues.push('in_denylist');

  const localPart = context.email?.split('@')[0]?.toLowerCase();
  if (localPart && localPart.length >= 3 && normalized.includes(localPart)) {
    issues.push('contains_email_localpart');
  }

  return { ok: issues.length === 0, issues };
}
