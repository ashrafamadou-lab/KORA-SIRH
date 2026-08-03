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
 *  - SÉCURITÉ (clôture Phase 1) : le jeton de session vit dans un cookie HttpOnly
 *    posé par le SERVEUR — le JavaScript du navigateur ne le voit JAMAIS et rien
 *    n'est écrit dans localStorage/sessionStorage/IndexedDB ; seul le jeton CSRF
 *    (dérivé, non secret de session) est gardé EN MÉMOIRE et envoyé en entête
 *    X-KORA-CSRF sur chaque écriture ; le tenant est résolu par le SERVEUR à la
 *    connexion (slug saisi au login, jamais un tenant_id imposé) ; aucune donnée
 *    sensible n'est journalisée.
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
  // Temps & pointage (E10.1)
  timeModels: { method: 'get', path: '/time/schedules/models' },
  timeModelCreate: { method: 'post', path: '/time/schedules/models' },
  timeModel: { method: 'get', path: '/time/schedules/models/{id}' },
  timeModelRetire: { method: 'post', path: '/time/schedules/models/{id}/retire' },
  timeVersionCreate: { method: 'post', path: '/time/schedules/models/{id}/versions' },
  timeAssignments: { method: 'get', path: '/time/schedules/assignments' },
  timeAssign: { method: 'post', path: '/time/schedules/assignments' },
  timeAssignByUnit: { method: 'post', path: '/time/schedules/assignments/by-unit' },
  timeAssignmentClose: { method: 'post', path: '/time/schedules/assignments/{id}/close' },
  timeEmployeeSchedule: { method: 'get', path: '/time/employees/{id}/schedule' },
  timeHolidays: { method: 'get', path: '/time/holidays' },
  timeHolidayCreate: { method: 'post', path: '/time/holidays' },
  timeHolidayCalendarCreate: { method: 'post', path: '/time/holidays/calendars' },
  timeHolidayRetire: { method: 'post', path: '/time/holidays/{id}/retire' },
  timeExceptions: { method: 'get', path: '/time/exceptions' },
  timeExceptionCreate: { method: 'post', path: '/time/exceptions' },
  timeExceptionRetire: { method: 'post', path: '/time/exceptions/{id}/retire' },
  timeDevices: { method: 'get', path: '/time/devices' },
  timeDeviceCreate: { method: 'post', path: '/time/devices' },
  timeDevicePatch: { method: 'patch', path: '/time/devices/{id}' },
  timeMappings: { method: 'get', path: '/time/mappings' },
  timeMappingCreate: { method: 'post', path: '/time/mappings' },
  timeMappingRetire: { method: 'post', path: '/time/mappings/{id}/retire' },
  timeImport: { method: 'post', path: '/time/punches/import' },
  timeBatches: { method: 'get', path: '/time/batches' },
  timeBatch: { method: 'get', path: '/time/batches/{id}' },
  timeBatchFile: { method: 'get', path: '/time/batches/{id}/file' },
  timeRawPunches: { method: 'get', path: '/time/punches/raw' },
  timeMyPunches: { method: 'get', path: '/time/punches/mine' },
  timeUnmatched: { method: 'get', path: '/time/punches/unmatched' },
  timeRenormalize: { method: 'post', path: '/time/punches/renormalize' },
  timeManualPunch: { method: 'post', path: '/time/punches/manual' },
  // Moteur de présence (E10.2)
  timeCalcRun: { method: 'post', path: '/time/calc/run' },
  timeCalcRecalc: { method: 'post', path: '/time/calc/recalc' },
  timeCalcPreview: { method: 'post', path: '/time/calc/preview' },
  timeCalcRuns: { method: 'get', path: '/time/calc/runs' },
  timeCalcRunDetail: { method: 'get', path: '/time/calc/runs/{id}' },
  timeResults: { method: 'get', path: '/time/results' },
  timeResultsMine: { method: 'get', path: '/time/results/mine' },
  timeResultsEmployee: { method: 'get', path: '/time/results/employee/{id}' },
  timeResultDay: { method: 'get', path: '/time/results/day' },
  timeResultHistory: { method: 'get', path: '/time/results/history' },
  timeResultCompare: { method: 'get', path: '/time/results/compare' },
  timeAggregates: { method: 'get', path: '/time/results/aggregates' },
  timeAnomalyCatalog: { method: 'get', path: '/time/anomalies/catalog' },
  timeAnomalies: { method: 'get', path: '/time/anomalies' },
  timeAnomalyState: { method: 'post', path: '/time/anomalies/{id}/state' },
  // Corrections & clôture (E10.3)
  timeAnomalyAssign: { method: 'post', path: '/time/anomalies/{id}/assign' },
  timeCorrectionCreate: { method: 'post', path: '/time/corrections' },
  timeCorrections: { method: 'get', path: '/time/corrections' },
  timeCorrectionsMine: { method: 'get', path: '/time/corrections/mine' },
  timeCorrection: { method: 'get', path: '/time/corrections/{id}' },
  timeCorrectionSubmit: { method: 'post', path: '/time/corrections/{id}/submit' },
  timeCorrectionCancel: { method: 'post', path: '/time/corrections/{id}/cancel' },
  timeCorrectionDecide: { method: 'post', path: '/time/corrections/{id}/decide' },
  timeCorrectionApply: { method: 'post', path: '/time/corrections/{id}/apply' },
  timeCorrectionAttach: { method: 'post', path: '/time/corrections/{id}/attachments' },
  timeAttachment: { method: 'get', path: '/time/corrections/attachments/{id}' },
  timePeriods: { method: 'get', path: '/time/periods' },
  timePeriodCreate: { method: 'post', path: '/time/periods' },
  timePeriodStatus: { method: 'post', path: '/time/periods/{id}/status' },
  timePreclose: { method: 'get', path: '/time/periods/{id}/preclose' },
  timePeriodClose: { method: 'post', path: '/time/periods/{id}/close' },
  timePeriodReopen: { method: 'post', path: '/time/periods/{id}/reopen' },
  timePeriodCloses: { method: 'get', path: '/time/periods/{id}/closes' },
  timeClosePayroll: { method: 'get', path: '/time/closes/{id}/payroll' },
  timeCloseVerify: { method: 'get', path: '/time/closes/{id}/verify' },
  timeCloseExports: { method: 'get', path: '/time/closes/{id}/exports' },
  timeCloseExportCreate: { method: 'post', path: '/time/closes/{id}/exports' },
  timePayrollExportDownload: { method: 'get', path: '/time/payroll-exports/{id}/download' },
  // Congés & absences (E11.1)
  leaveTypes: { method: 'get', path: '/leave/types' },
  leaveTypeCreate: { method: 'post', path: '/leave/types' },
  leaveTypeUpdate: { method: 'post', path: '/leave/types/{id}' },
  leavePolicies: { method: 'get', path: '/leave/policies' },
  leavePolicyCreate: { method: 'post', path: '/leave/policies' },
  leavePolicyVersionAdd: { method: 'post', path: '/leave/policies/{id}/versions' },
  leavePolicyStatus: { method: 'post', path: '/leave/policies/{id}/status' },
  leavePolicyResolve: { method: 'get', path: '/leave/policies/resolve' },
  leavePolicyPopulation: { method: 'get', path: '/leave/policies/{id}/population' },
  leaveAccrualRun: { method: 'post', path: '/leave/accrual/run' },
  leaveAccrualRuns: { method: 'get', path: '/leave/accrual/runs' },
  leaveBalances: { method: 'get', path: '/leave/balances' },
  leaveBalancesMine: { method: 'get', path: '/leave/balances/mine' },
  leaveProjection: { method: 'get', path: '/leave/projection' },
  leaveLedger: { method: 'get', path: '/leave/ledger' },
  leaveLedgerMine: { method: 'get', path: '/leave/ledger/mine' },
  leaveCount: { method: 'get', path: '/leave/count' },
  leaveAdjust: { method: 'post', path: '/leave/adjust' },
  leaveOpeningsImport: { method: 'post', path: '/leave/openings/import' },
  leaveOpenings: { method: 'get', path: '/leave/openings' },
  // Demandes de congés (E11.2)
  leaveRequestCreate: { method: 'post', path: '/leave/requests' },
  leaveRequestUpdate: { method: 'post', path: '/leave/requests/{id}' },
  leaveRequestDetail: { method: 'get', path: '/leave/requests/{id}' },
  leaveRequestPreview: { method: 'get', path: '/leave/requests/preview/{id}' },
  leaveRequestConfirm: { method: 'post', path: '/leave/requests/{id}/confirm' },
  leaveRequestSubmit: { method: 'post', path: '/leave/requests/{id}/submit' },
  leaveRequestDecide: { method: 'post', path: '/leave/requests/{id}/decide' },
  leaveRequestWithdraw: { method: 'post', path: '/leave/requests/{id}/withdraw' },
  leaveRequestApply: { method: 'post', path: '/leave/requests/{id}/apply' },
  leaveRequestCancelApproved: { method: 'post', path: '/leave/requests/{id}/cancel-approved' },
  leaveRequestExpire: { method: 'post', path: '/leave/requests/{id}/expire' },
  leaveRequestsMine: { method: 'get', path: '/leave/requests/mine' },
  leaveRequestsTeam: { method: 'get', path: '/leave/requests/team' },
  leaveRequestsQueue: { method: 'get', path: '/leave/requests/queue' },
  leaveRequestAttachmentAdd: { method: 'post', path: '/leave/requests/{id}/attachments' },
  leaveRequestAttachment: { method: 'get', path: '/leave/requests/attachments/{id}' },
  leaveRequestAttachmentVerify: { method: 'post', path: '/leave/requests/attachments/{id}/verify' },
  leaveCalendar: { method: 'get', path: '/leave/calendar' },
  leaveCalendarExport: { method: 'get', path: '/leave/calendar/export' },
} as const;

export type ContractKey = keyof typeof API_CONTRACT;

// ---------------------------------------------------------------------------
// Types de réponses (miroir manuel du contrat OpenAPI servi par l'API)
// ---------------------------------------------------------------------------

/** Réponse de connexion en transport COOKIE : jamais de jeton de session. */
export interface LoginResponse { expiresAt: string; user: { id: string; email: string }; csrfToken: string }
export interface MeResponse {
  tenantId: string; userId: string; sessionId: string; email: string;
  permissions: string[];
  scopes: Array<{ type: string; ref: string | null }>;
  roles: Array<{ key: string; name: string }>;
  locale: 'fr' | 'en';
  mfaEnabled: boolean;
  tenant: { slug: string; name: string } | null;
  /** Présent quand la session vient du cookie — recharge le CSRF en mémoire. */
  csrfToken?: string;
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

// Temps & pointage (E10.1)
export interface TimeModelRow {
  id: string; code: string; labelFr: string; labelEn: string; kind: 'fixed' | 'rotation';
  status: string; versionCount: number; lastEffectiveFrom: string | null; assignedToday: number;
}
export interface TimeScheduleDay {
  dayIndex: number; isRest: boolean; startMinute: number | null; endMinute: number | null;
  breakStartMinute: number | null; breakEndMinute: number | null; label: string | null;
}
export interface TimeModelDetail extends Omit<TimeModelRow, 'versionCount' | 'lastEffectiveFrom' | 'assignedToday'> {
  versions: Array<{ id: string; version: number; effectiveFrom: string; cycleDays: number; notes: string | null; days: TimeScheduleDay[] }>;
}
export interface TimeAssignmentRow {
  id: string; employeeId: string; matricule: string; firstName: string; lastName: string;
  modelId: string; modelCode: string; modelLabelFr: string; modelLabelEn: string;
  anchorDate: string; effectiveFrom: string; effectiveTo: string | null;
}
export interface TimeDeviceRow {
  id: string; code: string; label: string; kind: string; status: string;
  siteId: string | null; siteCode: string | null; timeZone: string | null; mappingCount: number;
}
export interface TimeMappingRow {
  id: string; externalId: string; employeeId: string; matricule: string;
  firstName: string; lastName: string; deviceId: string | null; deviceCode: string | null; status: string;
}
export interface TimeBatchRow {
  id: string; source: string; filename: string | null; status: 'applied' | 'partial' | 'rejected';
  atomic: boolean; createdAt: string; linesReceived: number; linesAccepted: number;
  linesDuplicated: number; linesRejected: number; linesUnmatched: number;
  fileSha256: string | null; fileKept: boolean; createdByEmail: string | null;
}
export interface TimeBatchDetail extends TimeBatchRow {
  errorReport: Array<{ line: number; error: string }>;
  columnMapping: Record<string, string>;
}
export interface TimeRawPunchRow {
  id: string; batchId: string; lineNo: number | null; externalEmployeeId: string;
  sourceDateTimeRaw: string; sourceTz: string | null; eventTypeRaw: string | null;
  deviceRef: string | null; deviceCode: string | null; receivedAt: string;
  matchStatus: string | null; eventType: string | null; occurredAt: string | null;
  localDate: string | null; localTime: string | null; tz: string | null; note: string | null;
  matricule: string | null; firstName: string | null; lastName: string | null;
}
export interface TimeMyEventRow {
  id: string; occurredAt: string | null; localDate: string | null; localTime: string | null;
  tz: string; eventType: string; matchStatus: string; deviceCode: string | null; siteCode: string | null;
}
export interface TimeUnmatchedRow {
  id: string; rawPunchId: string; matchStatus: string; note: string | null;
  localDate: string | null; localTime: string | null; tz: string | null;
  externalEmployeeId: string; sourceDateTimeRaw: string; batchId: string; deviceCode: string | null;
  matricule: string | null; firstName: string | null; lastName: string | null;
}
export interface TimeImportResult {
  kind: 'preview' | 'applied' | 'partial' | 'rejected';
  batchId?: string;
  counts: { received: number; accepted: number; duplicated: number; rejected: number; unmatched: number };
  errors: Array<{ line: number; error: string }>;
  effective?: Record<string, string>;
  wouldApply?: boolean;
}
// Moteur de présence (E10.2)
export type TimeDayStatus =
  | 'present' | 'late' | 'early_departure' | 'late_and_early_departure'
  | 'absent' | 'partial_presence' | 'incomplete_punches'
  | 'rest_day' | 'public_holiday' | 'worked_rest_day' | 'worked_public_holiday'
  | 'not_scheduled' | 'not_employed' | 'suspended' | 'unresolved';
export interface TimeDayResult {
  id: string; employeeId: string; workDate: string; version: number;
  dayStatus: TimeDayStatus; calcState: 'ok' | 'error'; calcNote: string | null;
  tz: string; scheduleModelCode: string | null; scheduleModelVersion: number | null;
  cycleDayIndex: number | null;
  plannedStartMinute: number | null; plannedEndMinute: number | null;
  plannedBreakStartMinute: number | null; plannedBreakEndMinute: number | null;
  plannedRest: boolean; holiday: boolean; exceptionKind: string | null;
  firstIn: string | null; lastOut: string | null;
  workPeriods: Array<{ startMinute: number; endMinute: number }>;
  presenceMinutes: number; workedMinutes: number; breakMinutes: number;
  lateMinutesRaw: number; lateMinutes: number;
  earlyDepartureMinutesRaw: number; earlyDepartureMinutes: number;
  absenceMinutes: number; nightMinutes: number; restDayMinutes: number; holidayMinutes: number;
  overtimeCandidateMinutes: number; engineVersion: string; openAnomalies: number;
  matricule?: string; firstName?: string; lastName?: string; siteCode?: string | null; unitCode?: string | null;
}
export interface TimeAnomalyItem {
  id: string; code: string; severity: 'info' | 'warning' | 'blocking';
  detail: string | null; refs: Record<string, unknown>;
  state: 'open' | 'acknowledged' | 'resolved' | 'dismissed';
  stateNote: string | null; stateAt: string | null; createdAt: string;
  workDate?: string; employeeId?: string; matricule?: string; firstName?: string; lastName?: string;
  dayStatus?: string;
}
export interface TimeDayDetail {
  result: TimeDayResult & {
    paramsUsed: Record<string, { value: unknown; parameterId: string | null; effectiveFrom: string | null; source: 'parametre' | 'defaut' }>;
    usedEventIds: string[]; calcRunId: string; computedAt: string;
  };
  anomalies: TimeAnomalyItem[];
  events: Array<{ id: string; localDate: string; localTime: string; eventType: string; tz: string; occurredAt: string | null; siteCode: string | null; deviceCode: string | null }>;
  versionCount: number; self: boolean;
}
export interface TimeCalcRun {
  id: string; periodStart: string; periodEnd: string; scopeKind: string; reason: string;
  isRecalc: boolean; engineVersion: string; status: string;
  startedAt: string; finishedAt: string | null;
  employeesCount: number; daysCount: number; resultsWritten: number; resultsUnchanged: number;
  resultsError: number; anomaliesCount: number; durationMs: number | null; errorNote?: string | null;
}
export interface TimeCalcPreviewOut {
  evaluated: number; wouldWrite: number; unchanged: number;
  diffs: Array<{ employeeId: string; date: string; currentVersion: number | null;
    currentStatus: string | null; nextStatus: string; changedFields: string[]; nextAnomalies: string[] }>;
}
export interface TimeHistoryVersion extends TimeDayResult {
  isCurrent: boolean; computedAt: string; runReason: string; runIsRecalc: boolean;
  runStartedAt: string; anomalyCount: number;
}
export interface TimeCompareOut {
  fields: Array<{ field: string; a: unknown; b: unknown }>;
  a: { version: number; runReason: string; runIsRecalc: boolean; computedAt: string };
  b: { version: number; runReason: string; runIsRecalc: boolean; computedAt: string };
}
export interface TimeAggregateRow {
  employeeId: string; matricule: string; firstName: string; lastName: string;
  daysTotal: number; expectedDays: number; presentDays: number; absentDays: number;
  unresolvedDays: number; lateCount: number; lateMinutes: number;
  earlyCount: number; earlyDepartureMinutes: number; workedMinutes: number; nightMinutes: number;
  restDayMinutes: number; holidayMinutes: number; overtimeCandidateMinutes: number; openAnomalies: number;
}
export interface TimeAnomalyCatalogItem { code: string; labelFr: string; labelEn: string; defaultSeverity: string }
// Corrections & clôture (E10.3)
export interface TimeCorrectionRow {
  id: string; employeeId: string; workDate: string; kind: string; origin: string; status: string;
  version: number; requesterUserId: string; motive: string; payload: Record<string, unknown>;
  beforeSnapshot: Record<string, unknown> | null; afterSnapshot: Record<string, unknown> | null;
  anomalyId: string | null; workflowInstanceId: string | null; appliedEventId: string | null;
  applicationError: string | null; submittedAt: string | null; decidedAt: string | null;
  appliedAt: string | null; createdAt: string;
  matricule: string; firstName: string; lastName: string; attachmentCount: number;
}
export interface TimeCorrectionDetail {
  request: TimeCorrectionRow;
  attachments: Array<{ id: string; filename: string; mime: string; byteSize: number; sensitive: boolean; avStatus: string; createdAt: string }>;
}
export interface TimePeriodRow {
  id: string; scopeKind: string; companyId: string | null; siteId: string | null;
  label: string; periodStart: string; periodEnd: string; status: string; revision: number;
  createdAt: string; closeCount: number; activeCloseNo: number | null;
}
export interface TimePrecloseControl { key: string; count: number; blocking: boolean }
export interface TimePrecloseOut {
  period: { id: string; label: string; status: string; revision: number; periodStart: string; periodEnd: string };
  controls: TimePrecloseControl[]; blockers: number; warnings: number; closable: boolean;
}
export interface TimeCloseRow {
  id: string; closeNo: number; periodRevision: number; engineVersion: string;
  datasetSha256: string; employeesCount: number; daysCount: number; resultsCount: number;
  totals: Record<string, number>; warnings: unknown[]; status: string;
  closedBy: string; closedAt: string; exportCount?: number;
  periodLabel?: string; periodStart?: string; periodEnd?: string; periodStatus?: string;
}
export interface TimePayrollRow {
  employeeId: string; matricule: string; firstName: string; lastName: string;
  expectedDays: number; presentDays: number; unjustifiedAbsenceDays: number;
  justified: Record<string, { days: number; minutes: number }>;
  lateMinutes: number; earlyDepartureMinutes: number; workedMinutes: number; nightMinutes: number;
  restDayMinutes: number; holidayMinutes: number; overtimeCandidateMinutes: number; correctionsApplied: number;
}
// ---------- Congés & absences (E11.1) ----------
export interface LeaveTypeRow {
  id: string; code: string; labelFr: string; labelEn: string; category: string;
  paid: boolean; unit: string; affectsPresence: boolean; affectsPayrollPrep: boolean;
  justification: string; depositDelayDays: number | null; retroactiveAllowed: boolean;
  negativeAllowed: boolean; confidential: boolean; workflowRequired: boolean;
  status: string; effectiveFrom: string; effectiveTo: string | null;
  policyCount: number; used: boolean;
}
export interface LeavePolicyVersionRow {
  version: number; effectiveFrom: string; accrualMode: string;
  accrualRateParam: string | null; accrualRateValue: number | null;
  referencePeriod: string; rounding: string;
  carryOverMaxParam: string | null; carryOverMaxValue: number | null;
  accrualRequiresService: boolean; prorataHire: boolean; prorataTermination: boolean;
  approvalLevels: number; noticeDays: number | null; minBlock: number | null; anticipationAllowed: boolean;
}
export interface LeavePolicyRow {
  id: string; code: string; labelFr: string; labelEn: string; status: string;
  absenceTypeId: string; typeCode: string; unit: string;
  countryCode: string | null; companyId: string | null; siteId: string | null;
  collectiveAgreement: string | null; professionalCategory: string | null;
  contractType: string | null; employeeStatus: string | null;
  seniorityMinMonths: number | null; workTime: string; populationKey: string | null;
  versionCount: number; lastEffectiveFrom: string | null; versions: LeavePolicyVersionRow[] | null;
}
export interface LeaveRunRow {
  id: string; periodStart: string; periodEnd: string; scopeKind: string; reason: string;
  kind: string; status: string; engineVersion: string; employeesCount: number;
  entriesWritten: number; entriesSkipped: number; errorsCount: number;
  errorReport: Array<Record<string, unknown>>; startedAt: string; finishedAt: string | null;
}
export interface LeaveBalanceRow {
  employeeId: string; absenceTypeId: string; unit: string; periodStart: string; periodEnd: string;
  accrued: number; adjustedOut: number; carriedIn: number; expired: number;
  reserved: number; consumed: number; available: number;
  typeCode: string; typeLabelFr: string; typeLabelEn: string; confidential: boolean;
  matricule: string; firstName: string; lastName: string;
}
export interface LeaveLedgerRow {
  id: string; employeeId: string; matricule: string; firstName: string; lastName: string;
  absenceTypeId: string; typeCode: string; confidential: boolean;
  policyId: string | null; policyVersion: number | null;
  periodStart: string; periodEnd: string; entryKind: string; quantity: number; unit: string;
  effectiveOn: string; origin: string; businessRef: string | null; reason: string | null;
  reversalOf: string | null; paramsUsed: Record<string, unknown>; idempotencyKey: string;
  createdBy: string | null; createdAt: string;
}
export interface LeaveProjectionOut {
  projection: {
    employeeId: string; typeId: string; toDate: string;
    currentAvailable: number; projected: number;
    plannedAccruals: Array<{ effectiveOn: string; quantity: number; monthLabel: string }>;
    note: string; policyCode: string; policyVersion: number;
  } | null;
}
export interface LeaveImportRow {
  id: string; filename: string | null; asOfDate: string; status: string; atomic: boolean;
  linesReceived: number; linesAccepted: number; linesDuplicated: number; linesRejected: number;
  errorReport: Array<Record<string, unknown>>; sourceNote: string | null; createdAt: string;
}

// ---------------- Demandes de congés (E11.2) ----------------
export interface LeaveCheckItem {
  code: string; level: 'error' | 'warning'; fr: string; en: string;
  detail?: Record<string, string | number | boolean>;
}
export interface LeaveRequestPreviewOut {
  preview: {
    requestId: string; status: string; version: number;
    quantity: number; unit: string;
    detail: Array<{ date: string; counted: number; why: string }>;
    errors: string[];
    checks: LeaveCheckItem[]; blocking: boolean;
    available: number | null; afterAvailable: number | null;
    projectedAtStart: number | null; projectionNote: string;
    retroactive: boolean; circuit: string;
    policyCode: string | null; policyVersion: number | null;
  };
}
export interface LeaveRequestListRow {
  id: string; status: string; version: number; onBehalf: boolean; source: string;
  typeCode: string | null; labelFr: string; labelEn: string; confidential: boolean;
  matricule?: string; firstName?: string; lastName?: string;
  startDate: string | null; endDate: string | null; quantity: string | null; unit: string | null;
  retroactive: boolean | null; comment?: string | null;
  submittedAt?: string | null; createdAt?: string; confirmedAt?: string | null;
  attachmentCount?: number; attachmentStatus?: string | null;
  draft?: Record<string, unknown>;
}
export interface LeaveRequestDetailOut {
  request: LeaveRequestListRow & {
    onBehalfReason: string | null; instanceId: string | null; cancelInstanceId: string | null;
    createdBy: string;
    versions: Array<{
      version: number; startDate: string; endDate: string; halfDayStart: boolean; halfDayEnd: boolean;
      hours: string | null; quantity: string; unit: string; checks: LeaveCheckItem[];
      countDetail: Array<{ date: string; counted: number; why: string }>;
      retroactive: boolean; retroReason: string | null; comment: string | null;
      policyId: string | null; policyVersion: number | null; instanceId: string | null; createdAt: string;
    }>;
    events: Array<{ version: number | null; event: string; actorUserId: string | null; detail: Record<string, unknown>; createdAt: string }>;
    attachments: Array<{ id: string; filename: string; mime: string; byteSize: number; sensitive: boolean; verifiedStatus: string; createdAt: string }>;
  };
}
export interface LeaveCalendarOut {
  calendar: {
    from: string; to: string;
    employees: Array<{ id: string; matricule: string; firstName: string; lastName: string }>;
    entries: Array<{
      employeeId: string; startDate: string; endDate: string; status: string;
      labelMode: string; typeCode: string | null; labelFr: string; labelEn: string;
    }>;
    holidays: Array<{ date: string; label: string }>;
    days: Array<{ date: string; headcount: number; approvedAbsent: number; pendingAbsent: number }>;
    alerts: Array<{ date: string; present: number; minPresence: number; level: string }>;
    minPresence: number | null;
  };
}

export interface TimeExportRow {
  id: string; schemaVersion: string; format: string; revision: number; sha256: string;
  employeesCount: number; status: string; generatedBy: string; generatedAt: string; byteSize: number;
}

export interface TimeEmployeeSchedule {
  assigned: boolean;
  date?: string; modelCode?: string; modelLabelFr?: string; modelLabelEn?: string; modelKind?: string;
  applicableVersion?: number | null; versionEffectiveFrom?: string; cycleDays?: number;
  anchorDate?: string; dayIndex?: number; day?: TimeScheduleDay | null;
  exception?: { kind: string; startMinute: number | null; endMinute: number | null; labelFr: string; labelEn: string; target: string } | null;
  holidays?: Array<{ labelFr: string; labelEn: string; calendarCode: string }>;
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

const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);

export class ApiClient {
  /** Jeton CSRF dérivé — EN MÉMOIRE uniquement, jamais un secret de session. */
  private csrf: string | null = null;
  private readonly baseUrl: string;
  private readonly onUnauthorized: (() => void) | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? '/api/v1';
    this.onUnauthorized = opts.onUnauthorized ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  setCsrf(token: string | null): void {
    this.csrf = token;
  }
  hasCsrf(): boolean {
    return this.csrf !== null;
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
        // Le cookie HttpOnly voyage tout seul, même origine uniquement.
        credentials: 'same-origin',
        headers: {
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(WRITE_METHODS.has(method) && this.csrf ? { 'x-kora-csrf': this.csrf } : {}),
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
      res = await this.fetchImpl(url, { method: 'GET', credentials: 'same-origin' });
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
