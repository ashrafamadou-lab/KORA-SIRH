/**
 * Salariés (E9 via PWA) — liste bornée au périmètre (contrôle serveur), fiche à
 * onglets. Les zones personnelle/administrative/documents ne sont demandées à l'API
 * que sur ouverture d'onglet ET si la permission existe : chaque lecture est
 * journalisée par le serveur. Le frontend ne reconstruit JAMAIS une donnée masquée.
 */
import { h } from '../core/dom.ts';
import { t, type MessageKey } from '../core/i18n.ts';
import { fmtDate, fmtDateTime, toIsoDate } from '../core/format.ts';
import type { Session } from '../core/session.ts';
import {
  ApiError,
  type EmployeeDetail, type EmployeeListItem,
} from '../core/api.ts';
import {
  button, dataTable, field, kv, maskedValue, pageTitle, statusBadge, stateForError, states, tabs,
} from '../ui/kit.ts';
import { navigate } from '../core/router.ts';

const EMP_STATUS_KEY: Record<string, MessageKey> = {
  draft: 'emp.status.draft', pre_hire: 'emp.status.pre_hire', active: 'emp.status.active',
  suspended: 'emp.status.suspended', on_leave: 'emp.status.on_leave',
  terminated: 'emp.status.terminated', archived: 'emp.status.archived',
};
const EVENT_KEY: Record<string, MessageKey> = {
  hire: 'emp.event.hire', confirmation: 'emp.event.confirmation', transfer: 'emp.event.transfer',
  promotion: 'emp.event.promotion', position_change: 'emp.event.position_change',
  site_change: 'emp.event.site_change', unit_change: 'emp.event.unit_change',
  manager_change: 'emp.event.manager_change', suspension: 'emp.event.suspension',
  return: 'emp.event.return', termination: 'emp.event.termination',
  reinstatement: 'emp.event.reinstatement', status_change: 'emp.event.status_change',
};

function statusLabel(status: string): string {
  const key = EMP_STATUS_KEY[status];
  return key ? t(key) : status;
}

function displayName(e: EmployeeListItem): string {
  const first = e.usageFirstName ?? e.firstName;
  const last = e.usageLastName ?? e.lastName;
  return `${last.toUpperCase()} ${first}`;
}

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

export async function employeesListPage(session: Session, query: URLSearchParams): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('emp.title')));
  root.appendChild(h('p', { class: 'section-note' }, t('emp.scopeNote')));

  const state = {
    query: query.get('q') ?? '',
    status: query.get('status') ?? '',
    page: Number(query.get('page') ?? '1') || 1,
  };
  const PAGE_SIZE = 25;

  const searchField = field('emp.searchPlaceholder', { value: state.query, placeholder: t('emp.searchPlaceholder') });
  const statusSelect = h('select', { 'aria-label': t('emp.status') }) as HTMLSelectElement;
  statusSelect.appendChild(h('option', { value: '' }, t('table.filters')));
  for (const s of Object.keys(EMP_STATUS_KEY)) {
    const opt = h('option', { value: s }, statusLabel(s)) as HTMLOptionElement;
    if (s === state.status) opt.selected = true;
    statusSelect.appendChild(opt);
  }
  const applyBtn = button(t('app.search'), () => {
    state.query = searchField.input.value.trim();
    state.status = statusSelect.value;
    state.page = 1;
    void load();
  }, { variant: 'primary' });
  const clearBtn = button(t('table.clearFilters'), () => {
    searchField.input.value = '';
    statusSelect.value = '';
    state.query = '';
    state.status = '';
    state.page = 1;
    void load();
  });
  const filters = h('div', { class: 'filters' },
    searchField.wrap,
    h('div', { class: 'field' }, h('label', {}, t('emp.status')), statusSelect),
    applyBtn, clearBtn,
  );
  root.appendChild(filters);

  const zone = h('div', {});
  root.appendChild(zone);

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: EmployeeListItem[] }>('employees', {
        query: {
          query: state.query || undefined,
          status: state.status || undefined,
          limit: PAGE_SIZE + 1,
          offset: (state.page - 1) * PAGE_SIZE,
        },
      });
      const hasMore = res.items.length > PAGE_SIZE;
      const rows = res.items.slice(0, PAGE_SIZE);
      if (rows.length === 0) {
        zone.replaceChildren(states.empty(state.query || state.status ? 'state.emptyFiltered' : 'state.empty'));
        return;
      }
      zone.replaceChildren(dataTable<EmployeeListItem>({
        columns: [
          { key: 'matricule', labelKey: 'emp.matricule', render: (r) => h('span', { class: 'mono' }, r.matricule) },
          { key: 'name', labelKey: 'emp.name', render: (r) => displayName(r) },
          { key: 'status', labelKey: 'emp.status', render: (r) => statusBadge(r.status, statusLabel(r.status)) },
          { key: 'hireDate', labelKey: 'emp.hireDate', render: (r) => fmtDate(r.hireDate) },
          { key: 'workEmail', labelKey: 'emp.workEmail', render: (r) => r.workEmail ?? t('app.none') },
        ],
        rows,
        onRowClick: (r) => navigate(`/employees/${r.id}`),
        page: state.page,
        hasMore,
        onPage: (p) => {
          state.page = p;
          void load();
        },
      }));
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }

  await load();
  return root;
}

// ---------------------------------------------------------------------------
// Fiche à onglets
// ---------------------------------------------------------------------------

interface PrivateZone {
  birthDate: string | null; birthPlace: string | null; nationality: string | null; sex: string | null;
  personalEmail: string | null; personalPhone: string | null;
  addressLine: string | null; addressCity: string | null; addressCountry: string | null;
  emergencyName: string | null; emergencyRelation: string | null; emergencyPhone: string | null;
}
interface IdentifierZone {
  cnssNumber: string | null; taxId: string | null;
  idDocumentType: string | null; idDocumentNumber: string | null; idDocumentExpiry: string | null;
}
interface DocumentMeta { id: string; docType: string; label: string; sensitive: boolean; createdAt: string }
interface CareerEvent { id: string; eventType: string; effectiveDate: string; details: Record<string, unknown>; occurredAt: string }
interface AssignmentRow {
  id: string; companyId: string; siteId: string | null; unitId: string; positionId: string | null;
  isPrimary: boolean; assignmentKind: string; allocationPct: number;
  effectiveFrom: string; effectiveTo: string | null;
}
interface ManagerInfo { employeeId: string | null; matricule?: string; firstName?: string; lastName?: string; via?: string }

export async function employeeDetailPage(session: Session, id: string): Promise<HTMLElement> {
  const root = h('div', {});
  let detail: EmployeeDetail;
  try {
    detail = await session.api.call<EmployeeDetail>('employee', { params: { id } });
  } catch (e) {
    return stateForError(e as ApiError);
  }

  root.appendChild(pageTitle(`${displayName(detail)} · ${detail.matricule}`,
    statusBadge(detail.status, statusLabel(detail.status))));

  const tabDefs: Array<{ key: string; labelKey: MessageKey; visible: boolean }> = [
    { key: 'professional', labelKey: 'emp.tab.professional', visible: true },
    { key: 'private', labelKey: 'emp.tab.private', visible: session.hasPermission('employees.view_private') },
    { key: 'identifiers', labelKey: 'emp.tab.identifiers', visible: session.hasPermission('employees.view_identifiers') },
    { key: 'documents', labelKey: 'emp.tab.documents', visible: session.hasPermission('employees.view_documents') },
    { key: 'career', labelKey: 'emp.tab.career', visible: session.hasPermission('employees.view_history') },
    { key: 'assignments', labelKey: 'emp.tab.assignments', visible: session.hasPermission('employees.view_history') },
  ];
  const visibleTabs = tabDefs.filter((d) => d.visible);
  let active = 'professional';
  const tabBar = h('div', {});
  const panel = h('div', { role: 'tabpanel' });
  root.appendChild(tabBar);
  root.appendChild(panel);

  function renderTabs(): void {
    tabBar.replaceChildren(tabs(visibleTabs.map((d) => ({ key: d.key, label: t(d.labelKey) })), active, (key) => {
      active = key;
      renderTabs();
      void renderPanel();
    }));
  }

  async function renderPanel(): Promise<void> {
    panel.replaceChildren(states.loading());
    try {
      switch (active) {
        case 'professional': {
          panel.replaceChildren(await professionalTab(session, detail));
          return;
        }
        case 'private': {
          const res = await session.api.call<{ private: PrivateZone | null }>('employeePrivate', { params: { id } });
          panel.replaceChildren(privateTab(res.private));
          return;
        }
        case 'identifiers': {
          const res = await session.api.call<{ identifiers: IdentifierZone | null }>('employeeIdentifiers', { params: { id } });
          panel.replaceChildren(identifiersTab(res.identifiers));
          return;
        }
        case 'documents': {
          const res = await session.api.call<{ documents: DocumentMeta[] }>('employeeDocuments', { params: { id } });
          panel.replaceChildren(documentsTab(res.documents));
          return;
        }
        case 'career': {
          const res = await session.api.call<{ events: CareerEvent[] }>('employeeCareer', { params: { id } });
          panel.replaceChildren(careerTab(res.events));
          return;
        }
        case 'assignments': {
          const res = await session.api.call<{ assignments: AssignmentRow[] }>('employeeAssignments', { params: { id } });
          panel.replaceChildren(assignmentsTab(res.assignments));
          return;
        }
        default:
          panel.replaceChildren(states.empty());
      }
    } catch (e) {
      panel.replaceChildren(stateForError(e as ApiError, () => void renderPanel()));
    }
  }

  renderTabs();
  await renderPanel();
  return root;
}

async function professionalTab(session: Session, d: EmployeeDetail): Promise<HTMLElement> {
  const box = h('div', { class: 'glass card' });
  const entries: Array<[string, HTMLElement | string | null]> = [
    [t('emp.legalName'), `${d.lastName.toUpperCase()} ${d.firstName}`],
    [t('emp.usageName'), d.usageFirstName || d.usageLastName ? `${(d.usageLastName ?? d.lastName).toUpperCase()} ${d.usageFirstName ?? d.firstName}` : null],
    [t('emp.matricule'), h('span', { class: 'mono' }, d.matricule)],
    [t('emp.status'), statusBadge(d.status, statusLabel(d.status))],
    [t('emp.hireDate'), fmtDate(d.hireDate)],
    [t('emp.professionalStatus'), d.professionalStatus],
    [t('emp.workEmail'), d.workEmail],
    [t('emp.workPhone'), d.workPhone],
  ];
  if (d.currentAssignment) {
    entries.push([t('emp.company'), h('span', { class: 'mono' }, d.currentAssignment.companyCode)]);
    entries.push([t('emp.unit'), h('span', { class: 'mono' }, d.currentAssignment.unitCode)]);
    entries.push([t('emp.assignments.allocation'), `${d.currentAssignment.allocationPct}%`]);
  }
  // Responsable À AUJOURD'HUI — résolu par la structure (E8/E9), jamais recalculé côté client.
  try {
    const mgr = await session.api.call<{ manager: ManagerInfo | null }>('employeeManager', {
      params: { id: d.id }, query: { date: toIsoDate(new Date()) },
    });
    if (mgr.manager && mgr.manager.employeeId) {
      entries.push([t('emp.manager'), h('span', {},
        `${(mgr.manager.lastName ?? '').toUpperCase()} ${mgr.manager.firstName ?? ''} `,
        h('span', { class: 'section-note' },
          mgr.manager.via === 'override' ? t('emp.managerOverride') : t('emp.managerViaPosition')),
      )]);
    } else {
      entries.push([t('emp.manager'), t('emp.managerNone')]);
    }
  } catch {
    /* la fiche reste utile sans le responsable */
  }
  box.appendChild(kv(entries.filter(([, v]) => v !== null) as Array<[string, HTMLElement | string]>));
  return box;
}

function privateTab(z: PrivateZone | null): HTMLElement {
  const box = h('div', { class: 'glass card' });
  box.appendChild(h('p', { class: 'section-note' }, t('emp.privateAudited')));
  if (!z) {
    box.appendChild(states.empty());
    return box;
  }
  box.appendChild(kv([
    [t('emp.birthDate'), fmtDate(z.birthDate)],
    [t('emp.birthPlace'), z.birthPlace ?? t('app.none')],
    [t('emp.nationality'), z.nationality ?? t('app.none')],
    [t('emp.sex'), z.sex ?? t('app.none')],
    [t('emp.personalEmail'), z.personalEmail ?? t('app.none')],
    [t('emp.personalPhone'), z.personalPhone ?? t('app.none')],
    [t('emp.address'), [z.addressLine, z.addressCity, z.addressCountry].filter(Boolean).join(', ') || t('app.none')],
    [t('emp.emergencyContact'), z.emergencyName ? `${z.emergencyName} (${z.emergencyRelation ?? t('app.none')}) ${z.emergencyPhone ?? ''}` : t('app.none')],
  ]));
  return box;
}

function identifiersTab(z: IdentifierZone | null): HTMLElement {
  const box = h('div', { class: 'glass card' });
  box.appendChild(h('p', { class: 'section-note' }, t('emp.identifiersAudited')));
  if (!z) {
    box.appendChild(states.empty());
    return box;
  }
  box.appendChild(kv([
    [t('emp.cnss'), maskedOrMono(z.cnssNumber)],
    [t('emp.taxId'), maskedOrMono(z.taxId)],
    [t('emp.idDocument'), z.idDocumentType ? h('span', {}, `${z.idDocumentType} — `, maskedOrMono(z.idDocumentNumber)) : maskedValue(null)],
    [t('emp.idDocumentExpiry'), fmtDate(z.idDocumentExpiry)],
  ]));
  return box;
}

function maskedOrMono(v: string | null): HTMLElement {
  return v ? h('span', { class: 'mono' }, v) : maskedValue(null);
}

function documentsTab(docs: DocumentMeta[]): HTMLElement {
  const box = h('div', {});
  box.appendChild(h('p', { class: 'section-note' }, t('emp.documentsMeta')));
  if (docs.length === 0) {
    box.appendChild(states.empty());
    return box;
  }
  box.appendChild(dataTable<DocumentMeta>({
    columns: [
      { key: 'docType', labelKey: 'emp.docType', render: (r) => h('span', { class: 'mono' }, r.docType) },
      { key: 'label', labelKey: 'emp.docLabel', render: (r) => r.label },
      { key: 'sensitive', labelKey: 'emp.docSensitive', render: (r) => r.sensitive ? t('app.yes') : t('app.no') },
      { key: 'createdAt', labelKey: 'emp.docAddedAt', render: (r) => fmtDateTime(r.createdAt) },
    ],
    rows: docs,
  }));
  return box;
}

function careerTab(events: CareerEvent[]): HTMLElement {
  const box = h('div', { class: 'glass card' });
  box.appendChild(h('h2', {}, t('emp.career.title')));
  if (events.length === 0) {
    box.appendChild(h('p', { class: 'section-note' }, t('emp.career.emptyBody')));
    return box;
  }
  const list = h('ul', { class: 'timeline' });
  for (const ev of [...events].reverse()) {
    const key = EVENT_KEY[ev.eventType];
    list.appendChild(h('li', {},
      h('div', { class: 'when' }, fmtDate(ev.effectiveDate)),
      h('div', {}, h('strong', {}, key ? t(key) : ev.eventType)),
    ));
  }
  box.appendChild(list);
  return box;
}

function assignmentsTab(rows: AssignmentRow[]): HTMLElement {
  const box = h('div', {});
  box.appendChild(h('h2', {}, t('emp.assignments.title')));
  if (rows.length === 0) {
    box.appendChild(states.empty());
    return box;
  }
  const kindKey: Record<string, MessageKey> = {
    standard: 'emp.assignments.kind.standard', interim: 'emp.assignments.kind.interim', temporary: 'emp.assignments.kind.temporary',
  };
  box.appendChild(dataTable<AssignmentRow>({
    columns: [
      {
        key: 'primary', labelKey: 'emp.tab.assignments',
        render: (r) => statusBadge(r.isPrimary ? 'active' : 'pending', r.isPrimary ? t('emp.assignments.primary') : t('emp.assignments.secondary')),
      },
      { key: 'kind', labelKey: 'org.type', render: (r) => { const k = kindKey[r.assignmentKind]; return k ? t(k) : r.assignmentKind; } },
      { key: 'allocation', labelKey: 'emp.assignments.allocation', render: (r) => `${r.allocationPct}%` },
      { key: 'from', labelKey: 'emp.assignments.from', render: (r) => fmtDate(r.effectiveFrom) },
      { key: 'to', labelKey: 'emp.assignments.to', render: (r) => r.effectiveTo ? fmtDate(r.effectiveTo) : t('emp.assignments.open') },
    ],
    rows,
  }));
  return box;
}
