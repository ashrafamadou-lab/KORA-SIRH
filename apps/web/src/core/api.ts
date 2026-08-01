/**
 * Client API typé (E7) — couche UNIQUE d'accès réseau.
 *
 *  - CONTRAT EXPLICITE : chaque appel passe par la table API_CONTRACT (méthode +
 *    gabarit de chemin) ; un test de CI vérifie que chaque entrée existe dans la
 *    spécification OpenAPI servie par l'API — les routes du frontend ne peuvent pas
 *    dériver du contrat.
 *  - ERREURS CENTRALISÉES : 401 ⇒ purge de session + redirection connexion (session
 *    révoquée ou compte désactivé = déconnexion IMMÉDIATE) ; 403/404/409/423/429/503
 *    remontent en ApiError typée, Retry-After interprété ; panne réseau ⇒ 'offline'.
 *  - SÉCURITÉ : le jeton vit en mémoire (+ sessionStorage d'onglet pour survivre au
 *    rechargement — JAMAIS localStorage, JAMAIS IndexedDB) ; le tenant est résolu par
 *    le SERVEUR à la connexion (slug saisi au login, jamais un tenant_id imposé) ;
 *    aucune donnée sensible n'est journalisée.
 */

export type ApiErrorKind =
  | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'locked'
  | 'rate_limited' | 'unavailable' | 'invalid' | 'offline' | 'error';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterSeconds: number | null;
  /** Corps d'erreur métier (messages serveur, rapports d'import) — jamais de stack. */
  readonly body: unknown;

  constructor(kind: ApiErrorKind, status: number, message: string, opts: {
    code?: string | null; retryAfterSeconds?: number | null; body?: unknown;
  } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = opts.code ?? null;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
    this.body = opts.body ?? null;
  }
}

/** Table de contrat : chaque route utilisée par la PWA, vérifiée contre OpenAPI en CI. */
export const API_CONTRACT = {
  login: { method: 'post', path: '/auth/login' },
  me: { method: 'get', path: '/auth/me' },
  logout: { method: 'post', path: '/auth/logout' },
  changePassword: { method: 'post', path: '/auth/password' },
  sessions: { method: 'get', path: '/auth/sessions' },
  revokeSession: { method: 'delete', path: '/auth/sessions/{id}' },
  revokeOtherSessions: { method: 'post', path: '/auth/sessions/revoke-others' },
  notifications: { method: 'get', path: '/notifications' },
  notificationRead: { method: 'post', path: '/notifications/{id}/read' },
  notificationArchive: { method: 'post', path: '/notifications/{id}/archive' },
  notifyPreferences: { method: 'put', path: '/notifications/preferences' },
  employees: { method: 'get', path: '/employees' },
  employee: { method: 'get', path: '/employees/{id}' },
  employeePrivate: { method: 'get', path: '/employees/{id}/private' },
  employeeIdentifiers: { method: 'get', path: '/employees/{id}/identifiers' },
  employeeDocuments: { method: 'get', path: '/employees/{id}/documents' },
  employeeCareer: { method: 'get', path: '/employees/{id}/career' },
  employeeAssignments: { method: 'get', path: '/employees/{id}/assignments' },
  employeeAt: { method: 'get', path: '/employees/{id}/at' },
  employeeManager: { method: 'get', path: '/employees/{id}/manager' },
  orgCompanies: { method: 'get', path: '/org/companies' },
  orgSites: { method: 'get', path: '/org/sites' },
  orgUnits: { method: 'get', path: '/org/units' },
  orgPositions: { method: 'get', path: '/org/positions' },
  orgChart: { method: 'get', path: '/org/chart' },
  workflowInstances: { method: 'get', path: '/workflow/instances' },
  workflowInstance: { method: 'get', path: '/workflow/instances/{id}' },
  workflowApprove: { method: 'post', path: '/workflow/instances/{id}/approve' },
  workflowReject: { method: 'post', path: '/workflow/instances/{id}/reject' },
  workflowReturn: { method: 'post', path: '/workflow/instances/{id}/return' },
  workflowCancel: { method: 'post', path: '/workflow/instances/{id}/cancel' },
  adminUsers: { method: 'get', path: '/admin/users' },
  adminCreateUser: { method: 'post', path: '/admin/users' },
  adminActivateUser: { method: 'post', path: '/admin/users/{id}/activate' },
  adminDeactivateUser: { method: 'post', path: '/admin/users/{id}/deactivate' },
  adminAssignRoles: { method: 'post', path: '/admin/users/{id}/roles' },
  adminRevokeUserSessions: { method: 'post', path: '/admin/users/{id}/revoke-sessions' },
  adminRoles: { method: 'get', path: '/admin/roles' },
  configResolve: { method: 'get', path: '/config/parameters/resolve' },
  configHistory: { method: 'get', path: '/config/parameters/history' },
  auditEvents: { method: 'get', path: '/audit/events' },
  auditEvent: { method: 'get', path: '/audit/events/{id}' },
  auditExportCsv: { method: 'get', path: '/audit/export/csv' },
  auditExportJson: { method: 'get', path: '/audit/export/json' },
} as const;

export type ContractKey = keyof typeof API_CONTRACT;

// ---------------------------------------------------------------------------
// Types de réponses (miroir manuel du contrat OpenAPI servi par l'API)
// ---------------------------------------------------------------------------

export interface LoginResponse { token: string; expiresAt: string; user: { id: string; email: string } }
export interface MeResponse {
  tenantId: string; userId: string; sessionId: string; email: string;
  permissions: string[];
  scopes: Array<{ type: string; ref: string | null }>;
  roles: Array<{ key: string; name: string }>;
  locale: 'fr' | 'en';
  mfaEnabled: boolean;
  tenant: { slug: string; name: string } | null;
}
export interface ActiveSession {
  id: string; createdAt: string; lastSeenAt: string; ip: string | null; userAgent: string | null; current: boolean;
}
export interface NotificationItem {
  id: string; subject: string; body: string; readAt: string | null; archivedAt: string | null;
  mandatory: boolean; createdAt: string; templateKey: string;
}
export interface EmployeeListItem {
  id: string; matricule: string; firstName: string; lastName: string;
  usageFirstName: string | null; usageLastName: string | null;
  status: string; hireDate: string | null; professionalStatus: string | null;
  employerCompanyId: string | null; mainSiteId: string | null;
  workEmail: string | null; workPhone: string | null; photoRef: string | null;
}
export interface EmployeeDetail extends EmployeeListItem {
  createdAt: string; documentCount: number;
  currentAssignment: {
    id: string; companyId: string; siteId: string | null; unitId: string;
    positionId: string | null; jobId: string | null; costCenterId: string | null;
    assignmentKind: string; allocationPct: number;
    effectiveFrom: string; effectiveTo: string | null;
    unitCode: string; companyCode: string;
  } | null;
}
export interface OrgItem { id: string; code: string; labelFr: string; labelEn: string; status: string }
export interface OrgUnitItem extends OrgItem { unitType: string; companyId: string | null; parentUnitId: string | null }
export interface OrgChartNode {
  id: string; code: string; labelFr: string; labelEn: string; unitType: string; status: string;
  children: OrgChartNode[];
}
export interface WorkflowListItem {
  id: string; definitionKey: string; status: string; currentStepIndex: number;
  stepName: string | null; subjectType: string; subjectId: string;
  createdBy: string; createdAt: string; stepDeadline: string | null; revision: number;
}
export interface AdminUserRow {
  id: string; email: string; isActive: boolean; mfaEnabled: boolean; roles: string[];
}
export interface RoleRow { id: string; key: string; name: string; isSystem: boolean; permissions: string[] }
export interface AuditItem {
  id: string; occurredAt: string; actorUserId: string | null; action: string; module: string;
  recordType: string | null; recordId: string | null; result: string | null; reason: string | null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ApiClientOptions {
  baseUrl?: string;
  /** Déclenché sur TOUT 401 après connexion : purge + redirection (centralisé). */
  onUnauthorized?: () => void;
  /** Transport injectable (tests) — par défaut fetch global. */
  fetchImpl?: typeof fetch;
}

export class ApiClient {
  private token: string | null = null;
  private readonly baseUrl: string;
  private readonly onUnauthorized: (() => void) | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? '/api/v1';
    this.onUnauthorized = opts.onUnauthorized ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  setToken(token: string | null): void {
    this.token = token;
  }
  hasToken(): boolean {
    return this.token !== null;
  }

  /** Construit l'URL d'une entrée du contrat (les segments {x} sont encodés). */
  url(key: ContractKey, params: Record<string, string> = {}, query: Record<string, string | number | boolean | undefined> = {}): string {
    let path: string = API_CONTRACT[key].path;
    for (const [name, value] of Object.entries(params)) {
      path = path.replace(`{${name}}`, encodeURIComponent(value));
    }
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
  }

  async call<T>(key: ContractKey, opts: {
    params?: Record<string, string>;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    /** 401 attendu (login/MFA) : ne PAS déclencher la purge globale. */
    expectAuthErrors?: boolean;
  } = {}): Promise<T> {
    const { method } = API_CONTRACT[key];
    const url = this.url(key, opts.params ?? {}, opts.query ?? {});
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: method.toUpperCase(),
        headers: {
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch {
      // Panne réseau / hors connexion — aucun détail technique exposé.
      throw new ApiError('offline', 0, 'offline');
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (res.ok) return body as T;
    throw this.toError(res, body, opts.expectAuthErrors === true);
  }

  /** Téléchargement authentifié (exports audit) — retourne un Blob, jamais mis en cache. */
  async download(key: ContractKey, query: Record<string, string | number | boolean | undefined> = {}): Promise<{ blob: Blob; contentType: string }> {
    const url = this.url(key, {}, query);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      });
    } catch {
      throw new ApiError('offline', 0, 'offline');
    }
    if (!res.ok) throw this.toError(res, null, false);
    return { blob: await res.blob(), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  }

  private toError(res: Response, body: unknown, expectAuthErrors: boolean): ApiError {
    const b = (body ?? {}) as { message?: unknown; code?: unknown; retryAfterSeconds?: unknown };
    const code = typeof b.code === 'string' ? b.code : null;
    const headerRetry = Number(res.headers.get('retry-after'));
    const retryAfterSeconds = Number.isFinite(headerRetry) && headerRetry > 0
      ? headerRetry
      : typeof b.retryAfterSeconds === 'number' ? b.retryAfterSeconds : null;
    const message = typeof b.message === 'string' ? b.message : `HTTP ${res.status}`;
    switch (res.status) {
      case 400:
      case 422:
        return new ApiError('invalid', res.status, message, { code, body });
      case 401: {
        const err = new ApiError('unauthorized', 401, message, { code, body });
        if (!expectAuthErrors && this.onUnauthorized) this.onUnauthorized(); // session révoquée / compte désactivé ⇒ déconnexion immédiate
        return err;
      }
      case 403:
        return new ApiError('forbidden', 403, message, { code, body });
      case 404:
        return new ApiError('not_found', 404, message, { code, body });
      case 409:
        return new ApiError('conflict', 409, message, { code, body });
      case 423:
        return new ApiError('locked', 423, message, { code, retryAfterSeconds, body });
      case 429:
        return new ApiError('rate_limited', 429, message, { code, retryAfterSeconds, body });
      case 502:
      case 503:
      case 504:
        return new ApiError('unavailable', res.status, message, { code, retryAfterSeconds, body });
      default:
        return new ApiError('error', res.status, message, { code, body });
    }
  }
}
