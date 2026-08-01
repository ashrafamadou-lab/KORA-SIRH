/**
 * Notification Engine (E5) — domaine pur, zéro dépendance.
 *
 * Porte les décisions TESTABLES du moteur :
 *  - variables contrôlées : extraction des placeholders {{nom}}, validation d'un modèle
 *    (tout placeholder doit appartenir à la liste fermée), validation des valeurs à la
 *    publication (variable inconnue OU manquante ⇒ rejet AVANT tout envoi) ;
 *  - garde anti-secrets : les noms de variables évoquant un secret (mot de passe, jeton,
 *    MFA…) ou une donnée médicale sont bannis STRUCTURELLEMENT ; les valeurs qui
 *    ressemblent à un secret (JWT, Bearer, blob hex/base64/base32, clé privée) sont
 *    refusées ; `scrubText` assainit les messages d'erreur destinés aux journaux ;
 *  - canaux et préférences : in_app est le socle (jamais désactivable) ; les canaux
 *    sortants respectent les préférences utilisateur SAUF notification obligatoire ;
 *  - file de livraison : backoff exponentiel plafonné, calcul de l'état suivant
 *    (sent / failed / dead_letter à épuisement), machine à états miroir du trigger SQL.
 *
 * Limite assumée (documentée) : une donnée médicale exprimée en texte libre dans une
 * VALEUR ne peut pas être détectée de façon fiable ; la protection structurelle est le
 * bannissement des NOMS de variables médicaux + la discipline des modules métier (aucun
 * module ne passe de contenu médical au moteur de notifications). La garde de valeurs
 * cible les secrets techniques, détectables par leur forme.
 */

export type NotifyChannel = 'in_app' | 'email' | 'sms' | 'push';
export type OutboundChannel = Exclude<NotifyChannel, 'in_app'>;
export type NotifyLocale = 'fr' | 'en';
export type DeliveryStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled' | 'dead_letter';

export const NOTIFY_CHANNELS: readonly NotifyChannel[] = ['in_app', 'email', 'sms', 'push'];
export const OUTBOUND_CHANNELS: readonly OutboundChannel[] = ['email', 'sms', 'push'];

// ---------------------------------------------------------------------------
// Variables contrôlées
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
const VARIABLE_NAME_RE = /^[a-z][a-z0-9_.]{0,63}$/;

/**
 * Noms de variables interdits : secrets d'authentification et données médicales.
 * Volontairement STRICT (des faux positifs comme « secretariat » sont acceptés : la
 * sécurité prime sur la commodité de nommage — on renomme la variable, pas la règle).
 */
const FORBIDDEN_NAME_RE =
  /(password|passwd|pwd|mot_?de_?passe|secret|token|jeton|otp|totp|mfa|credential|api_?key|apikey|bearer|cookie|session_?(id|token|key)|private_?key|cle_?privee|medical|sante|health|diagnos|maladie|pathologi|vih|hiv)/i;

export function isForbiddenVariableName(name: string): boolean {
  return FORBIDDEN_NAME_RE.test(name);
}

/** Placeholders {{nom}} distincts d'un texte, dans l'ordre de première apparition. */
export function extractPlaceholders(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (!found.includes(m[1]!)) found.push(m[1]!);
  }
  return found;
}

export type ScalarValue = string | number | boolean;

export interface TemplateContent {
  variables: string[];
  channels: NotifyChannel[];
  subjectFr: string;
  subjectEn: string;
  bodyFr: string;
  bodyEn: string;
}

export type TemplateValidation = { ok: true } | { ok: false; issues: string[] };

/** Validation complète d'un modèle AVANT enregistrement (création/édition de draft). */
export function validateTemplateContent(t: TemplateContent): TemplateValidation {
  const issues: string[] = [];

  const seen = new Set<string>();
  for (const name of t.variables) {
    if (!VARIABLE_NAME_RE.test(name)) issues.push(`variable « ${name} » : nom invalide (minuscules, chiffres, _ et .)`);
    else if (isForbiddenVariableName(name)) issues.push(`variable « ${name} » : nom interdit (secret ou donnée médicale)`);
    if (seen.has(name)) issues.push(`variable « ${name} » : doublon`);
    seen.add(name);
  }

  if (t.channels.length === 0) issues.push('au moins un canal requis');
  if (!t.channels.includes('in_app')) issues.push('le canal in_app est le socle : il est obligatoire');
  for (const c of t.channels) {
    if (!NOTIFY_CHANNELS.includes(c)) issues.push(`canal inconnu : ${String(c)}`);
  }
  if (new Set(t.channels).size !== t.channels.length) issues.push('canaux en doublon');

  const texts: Array<[string, string]> = [
    ['subject_fr', t.subjectFr], ['subject_en', t.subjectEn],
    ['body_fr', t.bodyFr], ['body_en', t.bodyEn],
  ];
  for (const [label, text] of texts) {
    for (const ph of extractPlaceholders(text)) {
      if (!t.variables.includes(ph)) issues.push(`${label} : placeholder inconnu {{${ph}}} (hors variables déclarées)`);
    }
    const secret = looksLikeSecret(text);
    if (secret) issues.push(`${label} : contenu suspect (${secret}) — un modèle ne doit jamais embarquer de secret`);
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export type ValuesValidation = { ok: true } | { ok: false; missing: string[]; unknown: string[] };

/**
 * « Des variables inconnues ou manquantes sont rejetées avant l'envoi » : les valeurs
 * fournies doivent couvrir EXACTEMENT les variables déclarées du modèle.
 */
export function validateValues(variables: string[], values: Record<string, ScalarValue>): ValuesValidation {
  const provided = Object.keys(values);
  const missing = variables.filter((v) => !(v in values));
  const unknown = provided.filter((k) => !variables.includes(k));
  return missing.length === 0 && unknown.length === 0 ? { ok: true } : { ok: false, missing, unknown };
}

export type RenderResult =
  | { ok: true; subject: string; body: string }
  | { ok: false; missing: string[]; unknown: string[] };

function substitute(text: string, values: Record<string, ScalarValue>): string {
  return text.replace(PLACEHOLDER_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  );
}

/** Rend sujet + corps dans la langue demandée ; refuse si les valeurs ne couvrent pas le modèle. */
export function renderTemplate(
  t: TemplateContent,
  locale: NotifyLocale,
  values: Record<string, ScalarValue>,
): RenderResult {
  const v = validateValues(t.variables, values);
  if (!v.ok) return v;
  const subject = substitute(locale === 'en' ? t.subjectEn : t.subjectFr, values);
  const body = substitute(locale === 'en' ? t.bodyEn : t.bodyFr, values);
  return { ok: true, subject, body };
}

export function pickLocale(v: unknown): NotifyLocale {
  return v === 'en' ? 'en' : 'fr';
}

// ---------------------------------------------------------------------------
// Garde anti-secrets (valeurs et journaux)
// ---------------------------------------------------------------------------

const UUID_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/;
const BEARER_RE = /\bbearer\s+\S+/i;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const HEX_BLOB_RE = /\b[0-9a-fA-F]{32,}\b/;
const BASE64_BLOB_RE = /\b[A-Za-z0-9+/]{40,}={0,2}\b/;
// Base32 (secrets TOTP) : exige au moins un chiffre 2-7 dans la séquence pour éviter de
// signaler un mot en capitales ; les secrets aléatoires en contiennent quasi toujours.
const BASE32_BLOB_RE = /\b(?=[A-Z2-7]{16,}\b)[A-Z]*[2-7][A-Z2-7]*\b/;

/** Raison si la chaîne ressemble à un secret technique, sinon null. */
export function looksLikeSecret(value: string): string | null {
  if (UUID_VALUE_RE.test(value.trim())) return null; // identifiant légitime, pas un secret
  if (PRIVATE_KEY_RE.test(value)) return 'clé privée';
  if (JWT_RE.test(value)) return 'jeton JWT';
  if (BEARER_RE.test(value)) return 'jeton Bearer';
  if (HEX_BLOB_RE.test(value)) return 'blob hexadécimal (clé/empreinte)';
  if (BASE32_BLOB_RE.test(value)) return 'blob base32 (secret TOTP)';
  if (BASE64_BLOB_RE.test(value)) return 'blob base64';
  return null;
}

export interface SafetyViolation {
  name: string;
  reason: string;
}

export type SafetyCheck =
  | { ok: true; values: Record<string, ScalarValue> }
  | { ok: false; violations: SafetyViolation[] };

/**
 * Filtre de publication : noms interdits, types non scalaires, valeurs à forme de
 * secret et valeurs démesurées sont refusés — AVANT toute écriture.
 */
export function assertSafeVariables(input: Record<string, unknown>): SafetyCheck {
  const violations: SafetyViolation[] = [];
  const values: Record<string, ScalarValue> = {};
  for (const [name, raw] of Object.entries(input)) {
    if (!VARIABLE_NAME_RE.test(name)) {
      violations.push({ name, reason: 'nom invalide' });
      continue;
    }
    if (isForbiddenVariableName(name)) {
      violations.push({ name, reason: 'nom interdit (secret ou donnée médicale)' });
      continue;
    }
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      violations.push({ name, reason: 'valeur non scalaire (chaîne, nombre ou booléen requis)' });
      continue;
    }
    if (typeof raw === 'string') {
      if (raw.length > 1000) {
        violations.push({ name, reason: 'valeur trop longue (max 1000 caractères)' });
        continue;
      }
      const secret = looksLikeSecret(raw);
      if (secret) {
        violations.push({ name, reason: `valeur à forme de secret (${secret})` });
        continue;
      }
    }
    values[name] = raw as ScalarValue;
  }
  return violations.length === 0 ? { ok: true, values } : { ok: false, violations };
}

/**
 * Assainit un texte destiné aux JOURNAUX (messages d'erreur de transport) : masque tout
 * motif à forme de secret puis tronque. Jamais appliqué au contenu du message — le
 * contenu ne va tout simplement pas dans les journaux.
 */
export function scrubText(text: string, max = 300): string {
  const masked = text
    .replace(/-----BEGIN[\s\S]*?KEY-----/g, '‹masqué›')
    .replace(new RegExp(JWT_RE.source, 'g'), '‹masqué›')
    .replace(/\bbearer\s+\S+/gi, '‹masqué›')
    .replace(new RegExp(HEX_BLOB_RE.source, 'g'), '‹masqué›')
    .replace(new RegExp(BASE32_BLOB_RE.source, 'g'), '‹masqué›')
    .replace(new RegExp(BASE64_BLOB_RE.source, 'g'), '‹masqué›');
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

// ---------------------------------------------------------------------------
// Canaux et préférences
// ---------------------------------------------------------------------------

export interface ChannelDecisionInput {
  /** Canaux déclarés par le modèle (in_app obligatoire, validé en amont). */
  templateChannels: NotifyChannel[];
  /** Notification obligatoire : ignore les préférences utilisateur. */
  mandatory: boolean;
  /** Préférences par canal sortant — absent = activé (opt-out). */
  preferences: Partial<Record<OutboundChannel, boolean>>;
}

/**
 * Canaux effectifs pour UN destinataire : in_app toujours ; canaux sortants filtrés par
 * les préférences SAUF si la notification est obligatoire.
 */
export function channelsFor(input: ChannelDecisionInput): NotifyChannel[] {
  const result: NotifyChannel[] = [];
  for (const c of input.templateChannels) {
    if (c === 'in_app') {
      result.push(c);
      continue;
    }
    if (input.mandatory || input.preferences[c] !== false) result.push(c);
  }
  return result;
}

// ---------------------------------------------------------------------------
// File de livraison : backoff et machine à états
// ---------------------------------------------------------------------------

export interface BackoffOptions {
  baseMs: number;
  factor: number;
  maxMs: number;
}

/** Délai avant la PROCHAINE tentative après l'échec n° attemptNo (1-indexé), plafonné. */
export function backoffDelayMs(attemptNo: number, opts: BackoffOptions): number {
  if (attemptNo < 1 || !Number.isFinite(attemptNo)) return Math.max(0, opts.baseMs);
  const raw = opts.baseMs * Math.pow(opts.factor, attemptNo - 1);
  return Math.min(Math.max(0, Math.round(raw)), opts.maxMs);
}

/** État suivant d'une livraison après une tentative : sent, failed (réessai) ou dead_letter. */
export function nextDeliveryStatus(
  outcomeOk: boolean,
  attemptCount: number,
  maxAttempts: number,
): Extract<DeliveryStatus, 'sent' | 'failed' | 'dead_letter'> {
  if (outcomeOk) return 'sent';
  return attemptCount >= maxAttempts ? 'dead_letter' : 'failed';
}

/** Miroir exact du trigger SQL notify.guard_delivery_update (défense en profondeur). */
export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  pending: ['processing', 'cancelled'],
  processing: ['sent', 'failed', 'dead_letter'],
  failed: ['processing', 'cancelled'],
  dead_letter: ['pending'],
  cancelled: ['pending'],
  sent: [],
};

export function canTransitionDelivery(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return DELIVERY_TRANSITIONS[from]?.includes(to) ?? false;
}
