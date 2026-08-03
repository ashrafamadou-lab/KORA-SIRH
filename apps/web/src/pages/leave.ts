/**
 * Congés & absences (E11.1 via PWA) — écrans : catalogue des types (nature figée
 * après usage) et politiques versionnées (population, versions datées), exécutions
 * d'acquisition (idempotentes) + report/expiration + reprise des soldes (atomique),
 * soldes par salarié (portées réelles, types confidentiels cloisonnés) + ledger +
 * ajustement motivé, « Mes soldes » + projection conditionnelle.
 * RÈGLES : le solde n'est JAMAIS un champ modifiable ; cacher un bouton n'est
 * jamais la sécurité ; AUCUNE donnée individuelle de congé en cache hors ligne.
 */
import { h } from '../core/dom.ts';
import { t, type MessageKey } from '../core/i18n.ts';
import { fmtDateTime, toIsoDate } from '../core/format.ts';
import type { Session } from '../core/session.ts';
import type {
  ApiError, EmployeeListItem,
  LeaveBalanceRow, LeaveImportRow, LeaveLedgerRow, LeavePolicyRow, LeaveProjectionOut,
  LeaveRunRow, LeaveTypeRow,
} from '../core/api.ts';
import {
  button, dataTable, field, kv, pageTitle, selectField,
  stateForError, states, statusBadge, toast,
} from '../ui/kit.ts';

function tk(prefix: string, key: string): string {
  const k = (`${prefix}.${key}`) as MessageKey;
  try { return t(k); } catch { return key; }
}
const qty3 = (n: number): string => (Math.round(n * 1000) / 1000).toString();

function typeStatusBadge(status: string): HTMLElement {
  const tone = status === 'active' ? 'active' : status === 'archived' ? 'retired' : 'draft';
  return statusBadge(tone, tk('lv.typeStatus', status));
}

// ---------------------------------------------------------------------------
// Catalogue : types + politiques
// ---------------------------------------------------------------------------

export async function leaveCatalogPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('lv.catalogTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('lv.catalogHint')));
  const admin = session.hasPermission('leave.types_admin');
  const polAdmin = session.hasPermission('leave.policies_admin');
  const typesZone = h('div', {});
  const polZone = h('div', {});

  if (admin) {
    const code = field('lv.typeCode', { required: true, placeholder: 'CAP' });
    const labelFr = field('app.lang.fr', { required: true });
    const labelEn = field('app.lang.en', { required: true });
    const category = selectField('lv.typeCategory', [
      { value: 'legal', label: t('lv.category.legal') },
      { value: 'conventional', label: t('lv.category.conventional') },
      { value: 'internal', label: t('lv.category.internal') },
    ]);
    const unit = selectField('lv.unit', ['open_days', 'working_days', 'calendar_days', 'half_days', 'hours']
      .map((u) => ({ value: u, label: tk('lv.unit', u) })));
    const paidWrap = h('label', { class: 'field' }, h('input', { type: 'checkbox', checked: true }), ` ${t('lv.paid')}`);
    const confWrap = h('label', { class: 'field' }, h('input', { type: 'checkbox' }), ` ${t('lv.confidential')}`);
    const submit = button(t('lv.newType'), null, { variant: 'primary', type: 'submit' });
    const form = h('form', { class: 'filters' }, code.wrap, labelFr.wrap, labelEn.wrap, category.wrap, unit.wrap, paidWrap, confWrap, submit) as HTMLFormElement;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void (async () => {
        try {
          await session.api.call('leaveTypeCreate', {
            body: {
              code: code.input.value.trim().toUpperCase(), labelFr: labelFr.input.value.trim(), labelEn: labelEn.input.value.trim(),
              category: category.select.value, unit: unit.select.value,
              paid: (paidWrap.querySelector('input') as HTMLInputElement).checked,
              confidential: (confWrap.querySelector('input') as HTMLInputElement).checked,
            },
          });
          toast(t('app.save'));
          await loadTypes();
        } catch (e) {
          toast((e as ApiError).message, 'err');
        }
      })();
    });
    root.appendChild(h('div', { class: 'glass card' }, form));
  }
  root.appendChild(typesZone);
  root.appendChild(h('h2', { class: 'section-title' }, t('lv.policiesTitle')));
  root.appendChild(polZone);

  async function loadTypes(): Promise<void> {
    typesZone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: LeaveTypeRow[] }>('leaveTypes');
      typesZone.replaceChildren(dataTable<LeaveTypeRow>({
        columns: [
          { key: 'c', labelKey: 'lv.typeCode', render: (r) => h('span', { class: 'mono' }, r.code) },
          { key: 'l', labelKey: 'emp.name', render: (r) => r.labelFr },
          { key: 'cat', labelKey: 'lv.typeCategory', render: (r) => tk('lv.category', r.category) },
          { key: 'u', labelKey: 'lv.unit', render: (r) => tk('lv.unit', r.unit) },
          { key: 'p', labelKey: 'lv.paid', render: (r) => r.paid ? t('lv.paid') : t('lv.unpaid') },
          {
            key: 'cf', labelKey: 'lv.confidential',
            render: (r) => r.confidential ? statusBadge('retired', t('lv.confidential')) : h('span', {}, '—'),
          },
          { key: 's', labelKey: 'time.calStatus', render: (r) => typeStatusBadge(r.status) },
          { key: 'used', labelKey: 'lv.typeUsed', render: (r) => r.used || r.policyCount > 0 ? t('app.yes') : t('app.no') },
          {
            key: 'act', labelKey: 'app.actions',
            render: (r) => {
              if (!admin) return h('span', {}, '—');
              const wrap = h('span', { class: 'filters' });
              if (r.status !== 'active') {
                wrap.appendChild(button(t('lv.activate'), async () => {
                  try {
                    await session.api.call('leaveTypeUpdate', { params: { id: r.id }, body: { status: 'active' } });
                    await loadTypes();
                  } catch (e) { toast((e as ApiError).message, 'err'); }
                }, { variant: 'ghost' }));
              } else {
                wrap.appendChild(button(t('lv.deactivate'), async () => {
                  try {
                    await session.api.call('leaveTypeUpdate', { params: { id: r.id }, body: { status: 'inactive' } });
                    await loadTypes();
                  } catch (e) { toast((e as ApiError).message, 'err'); }
                }, { variant: 'ghost' }));
              }
              return wrap;
            },
          },
        ],
        rows: res.items,
      }));
    } catch (e) {
      typesZone.replaceChildren(stateForError(e as ApiError, () => void loadTypes()));
    }
  }

  async function loadPolicies(): Promise<void> {
    polZone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: LeavePolicyRow[] }>('leavePolicies');
      const blocks: HTMLElement[] = [];
      for (const p of res.items) {
        const selectors: string[] = [];
        if (p.countryCode) selectors.push(p.countryCode);
        if (p.professionalCategory) selectors.push(p.professionalCategory);
        if (p.employeeStatus) selectors.push(p.employeeStatus);
        if (p.seniorityMinMonths !== null) selectors.push(`≥ ${p.seniorityMinMonths} mois`);
        if (p.populationKey) selectors.push(p.populationKey);
        const card = h('div', { class: 'glass card' },
          h('h3', {}, `${p.code} — ${p.labelFr} `, statusBadge(p.status === 'active' ? 'active' : p.status === 'retired' ? 'retired' : 'draft', tk('lv.polStatus', p.status))),
          kv([
            [t('lv.polType'), `${p.typeCode} (${tk('lv.unit', p.unit)})`],
            [t('lv.polPopulation'), selectors.length > 0 ? selectors.join(' · ') : t('lv.polPopulationAll')],
            [t('lv.polVersions'), String(p.versionCount)],
          ]));
        if (p.versions && p.versions.length > 0) {
          card.appendChild(dataTable<NonNullable<LeavePolicyRow['versions']>[number]>({
            columns: [
              { key: 'v', labelKey: 'time.cVersion', render: (v) => h('span', { class: 'mono' }, `v${v.version}`) },
              { key: 'd', labelKey: 'lv.polEffectiveFrom', render: (v) => h('span', { class: 'mono' }, v.effectiveFrom) },
              { key: 'm', labelKey: 'lv.runKind', render: (v) => tk('lv.polMode', v.accrualMode) },
              {
                key: 'r', labelKey: 'lv.polRateParam',
                render: (v) => v.accrualRateParam
                  ? h('span', { class: 'mono' }, v.accrualRateParam)
                  : v.accrualRateValue !== null ? `${v.accrualRateValue} (${t('lv.polRateValue')})` : '—',
              },
              { key: 'co', labelKey: 'lv.polCarryMax', render: (v) => v.carryOverMaxValue !== null ? String(v.carryOverMaxValue) : v.carryOverMaxParam ?? '—' },
            ],
            rows: p.versions,
          }));
        }
        if (polAdmin) {
          const actions = h('div', { class: 'filters' });
          actions.appendChild(button(t('lv.polSeePopulation'), async () => {
            try {
              const pop = await session.api.call<{ count: number }>('leavePolicyPopulation', { params: { id: p.id } });
              toast(t('lv.polPopulationCount', { n: pop.count }));
            } catch (e) { toast((e as ApiError).message, 'err'); }
          }, { variant: 'ghost' }));
          if (p.status !== 'active') {
            actions.appendChild(button(t('lv.activate'), async () => {
              try {
                await session.api.call('leavePolicyStatus', { params: { id: p.id }, body: { status: 'active' } });
                await loadPolicies();
              } catch (e) { toast((e as ApiError).message, 'err'); }
            }, { variant: 'primary' }));
          }
          card.appendChild(actions);
        }
        blocks.push(card);
      }
      polZone.replaceChildren(...(blocks.length > 0 ? blocks : [h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('state.empty')))]));
    } catch (e) {
      polZone.replaceChildren(stateForError(e as ApiError, () => void loadPolicies()));
    }
  }

  await loadTypes();
  await loadPolicies();
  return root;
}

// ---------------------------------------------------------------------------
// Acquisitions + reprise
// ---------------------------------------------------------------------------

export async function leaveRunsPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('lv.runsTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('lv.runsHint')));
  const canRun = session.hasPermission('leave.accrual_run');
  const canImport = session.hasPermission('leave.openings_import');
  const runsZone = h('div', {});
  const importsZone = h('div', {});

  if (canRun) {
    const from = field('time.from', { type: 'date', required: true });
    const to = field('time.to', { type: 'date', required: true });
    from.input.value = toIsoDate(new Date()).slice(0, 8) + '01';
    to.input.value = toIsoDate(new Date());
    const kindSel = selectField('lv.runKind', [
      { value: 'accrual', label: t('lv.runKind.accrual') },
      { value: 'carry_over', label: t('lv.runKind.carry_over') },
      { value: 'recompute', label: t('lv.runKind.recompute') },
    ]);
    const reason = field('lv.runReason', { required: true });
    const submit = button(t('lv.runLaunch'), null, { variant: 'primary', type: 'submit' });
    const form = h('form', { class: 'filters' }, from.wrap, to.wrap, kindSel.wrap, reason.wrap, submit) as HTMLFormElement;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      void (async () => {
        try {
          const out = await session.api.call<{ run: LeaveRunRow }>('leaveAccrualRun', {
            body: {
              periodStart: from.input.value, periodEnd: to.input.value,
              scopeKind: 'tenant', reason: reason.input.value.trim(), kind: kindSel.select.value,
            },
          });
          toast(`${t('lv.runWritten')} : ${out.run.entriesWritten} · ${t('lv.runSkipped')} : ${out.run.entriesSkipped}`);
          await loadRuns();
        } catch (e) {
          toast((e as ApiError).message, 'err');
        } finally {
          submit.disabled = false;
        }
      })();
    });
    root.appendChild(h('div', { class: 'glass card' }, form));
  }
  root.appendChild(runsZone);

  // Reprise des soldes d'ouverture.
  root.appendChild(h('h2', { class: 'section-title' }, t('lv.importTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('lv.importHint')));
  if (canImport) {
    const asOf = field('lv.importAsOf', { type: 'date', required: true });
    asOf.input.value = toIsoDate(new Date());
    const fileWrap = h('div', { class: 'field' }, h('label', {}, 'CSV'), h('input', { type: 'file', accept: '.csv,.txt' }));
    const fileInput = fileWrap.querySelector('input') as HTMLInputElement;
    const zone = h('div', {});
    const doImport = async (mode: 'preview' | 'apply'): Promise<void> => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const out = await session.api.call<{ kind: string; counts: Record<string, number>; errors: Array<Record<string, unknown>> }>(
          'leaveOpeningsImport', {
            body: { mode, asOfDate: asOf.input.value, contentText: await file.text(), filename: file.name },
          });
        zone.replaceChildren(h('div', { class: 'glass card' },
          kv([
            [t('lv.importReceived'), String(out.counts['received'] ?? 0)],
            [t('lv.importAccepted'), String(out.counts['accepted'] ?? 0)],
            [t('lv.importDuplicated'), String(out.counts['duplicated'] ?? 0)],
            [t('lv.importRejected'), String(out.counts['rejected'] ?? 0)],
          ]),
          ...(out.errors.length > 0 ? [h('pre', { class: 'mono section-note' }, JSON.stringify(out.errors.slice(0, 10), null, 1))] : [])));
        toast(out.kind);
        if (mode === 'apply') await loadImports();
      } catch (e) {
        toast((e as ApiError).message, 'err');
      }
    };
    root.appendChild(h('div', { class: 'glass card' },
      h('div', { class: 'filters' }, asOf.wrap, fileWrap,
        button(t('lv.importPreview'), () => void doImport('preview'), { variant: 'ghost' }),
        button(t('lv.importApply'), () => void doImport('apply'), { variant: 'primary' })),
      zone));
  }
  root.appendChild(importsZone);

  async function loadRuns(): Promise<void> {
    runsZone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: LeaveRunRow[] }>('leaveAccrualRuns');
      runsZone.replaceChildren(res.items.length === 0 ? states.empty() : dataTable<LeaveRunRow>({
        columns: [
          { key: 'p', labelKey: 'time.runPeriod', render: (r) => h('span', { class: 'mono' }, `${r.periodStart} → ${r.periodEnd}`) },
          { key: 'k', labelKey: 'lv.runKind', render: (r) => tk('lv.runKind', r.kind) },
          { key: 'm', labelKey: 'lv.runReason', render: (r) => r.reason },
          {
            key: 's', labelKey: 'time.calStatus',
            render: (r) => statusBadge(r.status === 'completed' ? 'active' : r.status === 'failed' ? 'retired' : 'draft', tk('lv.runStatus', r.status)),
          },
          { key: 'w', labelKey: 'lv.runWritten', render: (r) => String(r.entriesWritten) },
          { key: 'sk', labelKey: 'lv.runSkipped', render: (r) => String(r.entriesSkipped) },
          { key: 'e', labelKey: 'lv.runErrors', render: (r) => String(r.errorsCount) },
          { key: 'at', labelKey: 'time.calDate', render: (r) => fmtDateTime(r.startedAt) },
        ],
        rows: res.items,
      }));
    } catch (e) {
      runsZone.replaceChildren(stateForError(e as ApiError, () => void loadRuns()));
    }
  }

  async function loadImports(): Promise<void> {
    if (!canImport) return;
    try {
      const res = await session.api.call<{ items: LeaveImportRow[] }>('leaveOpenings');
      importsZone.replaceChildren(res.items.length === 0 ? h('div', {}) : dataTable<LeaveImportRow>({
        columns: [
          { key: 'f', labelKey: 'time.file', render: (r) => r.filename ?? '—' },
          { key: 'd', labelKey: 'lv.importAsOf', render: (r) => h('span', { class: 'mono' }, r.asOfDate) },
          {
            key: 's', labelKey: 'time.calStatus',
            render: (r) => statusBadge(r.status === 'applied' ? 'active' : 'retired', r.status),
          },
          { key: 'a', labelKey: 'lv.importAccepted', render: (r) => String(r.linesAccepted) },
          { key: 'dup', labelKey: 'lv.importDuplicated', render: (r) => String(r.linesDuplicated) },
          { key: 'rej', labelKey: 'lv.importRejected', render: (r) => String(r.linesRejected) },
          { key: 'at', labelKey: 'time.calDate', render: (r) => fmtDateTime(r.createdAt) },
        ],
        rows: res.items,
      }));
    } catch { /* liste facultative */ }
  }

  await loadRuns();
  await loadImports();
  return root;
}

// ---------------------------------------------------------------------------
// Soldes des salariés + ledger + ajustement
// ---------------------------------------------------------------------------

const BALANCE_COLUMNS_DEF = (labelOf: (r: LeaveBalanceRow) => string) => [
  { key: 'm', labelKey: 'emp.matricule' as MessageKey, render: (r: LeaveBalanceRow) => h('span', { class: 'mono' }, r.matricule) },
  { key: 'n', labelKey: 'emp.name' as MessageKey, render: (r: LeaveBalanceRow) => `${r.firstName} ${r.lastName}` },
  { key: 't', labelKey: 'lv.polType' as MessageKey, render: labelOf },
  { key: 'per', labelKey: 'lv.period' as MessageKey, render: (r: LeaveBalanceRow) => h('span', { class: 'mono' }, `${r.periodStart} → ${r.periodEnd}`) },
  { key: 'ac', labelKey: 'lv.accrued' as MessageKey, render: (r: LeaveBalanceRow) => qty3(r.accrued) },
  { key: 'ci', labelKey: 'lv.carriedIn' as MessageKey, render: (r: LeaveBalanceRow) => qty3(r.carriedIn) },
  { key: 'ex', labelKey: 'lv.expired' as MessageKey, render: (r: LeaveBalanceRow) => qty3(r.expired) },
  { key: 're', labelKey: 'lv.reserved' as MessageKey, render: (r: LeaveBalanceRow) => qty3(r.reserved) },
  { key: 'co', labelKey: 'lv.consumed' as MessageKey, render: (r: LeaveBalanceRow) => qty3(r.consumed) },
  {
    key: 'av', labelKey: 'lv.available' as MessageKey,
    render: (r: LeaveBalanceRow) => h('strong', {}, `${qty3(r.available)} ${tk('lv.unit', r.unit)}`),
  },
];

export async function leaveBalancesPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('lv.balancesTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('lv.balancesHint')));
  const canAdjust = session.hasPermission('leave.balance_adjust');
  const canLedger = session.hasPermission('leave.ledger_view');
  const zone = h('div', {});
  const ledgerZone = h('div', {});

  let employees: EmployeeListItem[] = [];
  const empSel = selectField('lv.employee', [{ value: '', label: '—' }]);
  let types: LeaveTypeRow[] = [];
  try {
    const res = await session.api.call<{ items: EmployeeListItem[] }>('employees', { query: { limit: 200 } });
    employees = res.items;
    empSel.select.replaceChildren(h('option', { value: '' }, '—'),
      ...employees.map((e) => h('option', { value: e.id }, `${e.matricule} — ${e.firstName} ${e.lastName}`)));
  } catch { /* employees.view absent : filtre libre indisponible */ }
  try {
    types = (await session.api.call<{ items: LeaveTypeRow[] }>('leaveTypes')).items;
  } catch { /* silencieux */ }

  const go = button(t('app.search'), null, { variant: 'primary', type: 'submit' });
  const filters = h('form', { class: 'filters' }, empSel.wrap, go) as HTMLFormElement;
  root.appendChild(h('div', { class: 'glass card' }, filters));
  root.appendChild(zone);

  if (canAdjust && types.length > 0) {
    const typeSel = selectField('lv.polType', types.map((ty) => ({ value: ty.id, label: `${ty.code} — ${ty.labelFr}` })));
    const dirSel = selectField('lv.adjustDirection', [
      { value: 'credit', label: t('lv.adjustCredit') }, { value: 'debit', label: t('lv.adjustDebit') },
    ]);
    const qty = field('lv.adjustQty', { type: 'number', required: true });
    const reason = field('lv.adjustReason', { required: true });
    const from = field('time.from', { type: 'date', required: true });
    const to = field('time.to', { type: 'date', required: true });
    from.input.value = `${new Date().getUTCFullYear()}-01-01`;
    to.input.value = `${new Date().getUTCFullYear()}-12-31`;
    const submit = button(t('lv.adjustDo'), null, { variant: 'primary', type: 'submit' });
    const form = h('form', { class: 'filters' }, typeSel.wrap, dirSel.wrap, qty.wrap, reason.wrap, from.wrap, to.wrap, submit) as HTMLFormElement;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const employeeId = empSel.select.value;
      if (!employeeId) { toast(t('lv.employee'), 'err'); return; }
      void (async () => {
        try {
          const out = await session.api.call<{ status: string; before: number; after: number | null }>('leaveAdjust', {
            body: {
              employeeId, typeId: typeSel.select.value, direction: dirSel.select.value,
              quantity: Number(qty.input.value), reason: reason.input.value.trim(),
              periodStart: from.input.value, periodEnd: to.input.value,
            },
          });
          if (out.status === 'pending_workflow') toast(t('lv.adjustPending'));
          else toast(t('lv.adjustApplied', { before: qty3(out.before), after: qty3(out.after ?? 0) }));
          await load();
        } catch (e) {
          toast((e as ApiError).message, 'err');
        }
      })();
    });
    root.appendChild(h('h2', { class: 'section-title' }, t('lv.adjustTitle')));
    root.appendChild(h('p', { class: 'section-note' }, t('lv.adjustHint')));
    root.appendChild(h('div', { class: 'glass card' }, form));
  }
  root.appendChild(h('h2', { class: 'section-title' }, t('lv.ledgerTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('lv.ledgerHint')));
  root.appendChild(ledgerZone);

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: LeaveBalanceRow[] }>('leaveBalances', {
        query: { employeeId: empSel.select.value || undefined },
      });
      zone.replaceChildren(res.items.length === 0
        ? h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('lv.noBalanceYet')))
        : dataTable<LeaveBalanceRow>({ columns: BALANCE_COLUMNS_DEF((r) => r.typeCode), rows: res.items }));
      await loadLedger();
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }

  async function loadLedger(): Promise<void> {
    if (!canLedger) return;
    try {
      const res = await session.api.call<{ items: LeaveLedgerRow[] }>('leaveLedger', {
        query: { employeeId: empSel.select.value || undefined },
      });
      ledgerZone.replaceChildren(res.items.length === 0 ? h('div', {}) : ledgerTable(res.items));
    } catch { /* portée absente */ }
  }

  filters.addEventListener('submit', (ev) => { ev.preventDefault(); void load(); });
  await load();
  return root;
}

function ledgerTable(items: LeaveLedgerRow[]): HTMLElement {
  return dataTable<LeaveLedgerRow>({
    columns: [
      { key: 'd', labelKey: 'time.calDate', render: (r) => h('span', { class: 'mono' }, r.effectiveOn) },
      { key: 'who', labelKey: 'emp.matricule', render: (r) => h('span', { class: 'mono' }, r.matricule) },
      { key: 't', labelKey: 'lv.polType', render: (r) => r.typeCode },
      { key: 'k', labelKey: 'lv.runKind', render: (r) => tk('lv.kind', r.entryKind) },
      { key: 'q', labelKey: 'lv.adjustQty', render: (r) => `${qty3(r.quantity)} ${tk('lv.unit', r.unit)}` },
      { key: 'o', labelKey: 'time.historyMotive', render: (r) => `${tk('lv.origin', r.origin)}${r.reason ? ' · ' + r.reason : ''}` },
      {
        key: 'pol', labelKey: 'lv.policyRef',
        render: (r) => r.policyVersion !== null ? h('span', { class: 'mono' }, `v${r.policyVersion}`) : h('span', {}, '—'),
      },
      { key: 'per', labelKey: 'lv.period', render: (r) => h('span', { class: 'mono' }, r.periodStart) },
    ],
    rows: items,
  });
}

// ---------------------------------------------------------------------------
// Mes soldes + projection
// ---------------------------------------------------------------------------

export async function leaveMinePage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('lv.mineTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('lv.mineHint')));
  const zone = h('div', {});
  const projZone = h('div', {});
  const ledgerZone = h('div', {});
  root.appendChild(zone);
  root.appendChild(projZone);
  root.appendChild(h('h2', { class: 'section-title' }, t('lv.ledgerTitle')));
  root.appendChild(ledgerZone);

  let items: LeaveBalanceRow[] = [];
  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ linked: boolean; items: LeaveBalanceRow[] }>('leaveBalancesMine');
      if (!res.linked) {
        zone.replaceChildren(h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('lv.notLinked'))));
        return;
      }
      items = res.items;
      zone.replaceChildren(items.length === 0
        ? h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('lv.noBalanceYet')))
        : dataTable<LeaveBalanceRow>({ columns: BALANCE_COLUMNS_DEF((r) => r.typeLabelFr), rows: items }));
      buildProjection();
      await loadLedger();
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }

  function buildProjection(): void {
    if (items.length === 0) { projZone.replaceChildren(); return; }
    const typeSel = selectField('lv.polType', [...new Map(items.map((b) => [b.absenceTypeId, b])).values()]
      .map((b) => ({ value: b.absenceTypeId, label: b.typeLabelFr })));
    const dateF = field('lv.projectTo', { type: 'date', required: true });
    const year = new Date().getUTCFullYear();
    dateF.input.value = `${year}-12-31`;
    const out = h('div', {});
    const go = button(t('lv.projectBtn'), async () => {
      try {
        const res = await session.api.call<LeaveProjectionOut>('leaveProjection', {
          query: { typeId: typeSel.select.value, toDate: dateF.input.value },
        });
        const p = res.projection;
        out.replaceChildren(p === null ? h('p', { class: 'section-note' }, '—') : kv([
          [t('lv.available'), qty3(p.currentAvailable)],
          [t('lv.projected', { date: p.toDate }), h('strong', {}, qty3(p.projected))],
          [t('lv.policyRef'), `${p.policyCode} v${p.policyVersion}`],
        ]));
        out.appendChild(h('p', { class: 'section-note' }, t('lv.projectionNote')));
      } catch (e) {
        toast((e as ApiError).message, 'err');
      }
    }, { variant: 'primary' });
    projZone.replaceChildren(h('div', { class: 'glass card' },
      h('div', { class: 'filters' }, typeSel.wrap, dateF.wrap, go), out));
  }

  async function loadLedger(): Promise<void> {
    try {
      const res = await session.api.call<{ items: LeaveLedgerRow[] }>('leaveLedgerMine');
      ledgerZone.replaceChildren(res.items.length === 0 ? h('div', {}) : ledgerTable(res.items));
    } catch { /* silencieux */ }
  }

  await load();
  return root;
}
