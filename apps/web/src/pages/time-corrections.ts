/**
 * Corrections & clôture (E10.3 via PWA) — écrans : ESS « Mes demandes »
 * (déclaration, pièce, soumission, suivi, annulation, avant/après), file des
 * demandes (manager/administration : décision approve/reject/return, relance
 * d'application), périodes (cycle, PRÉ-CLÔTURE, clôture confirmée, réouverture
 * motivée), préparation paie (variables temps d'une clôture, vérification
 * d'empreinte, exports immuables téléchargés).
 *
 * RÈGLES : cacher un bouton n'est JAMAIS la sécurité (le serveur tranche) ;
 * AUCUNE donnée de correction, pièce, clôture ou paie en cache hors ligne ;
 * une pièce SENSIBLE n'affiche jamais son nom hors de son cercle ; aucun
 * montant nulle part — des variables temps, la paie viendra plus tard.
 */
import { h } from '../core/dom.ts';
import { t, type MessageKey } from '../core/i18n.ts';
import { fmtDateTime, toIsoDate } from '../core/format.ts';
import type { Session } from '../core/session.ts';
import type {
  ApiError, EmployeeListItem,
  TimeCloseRow, TimeCorrectionDetail, TimeCorrectionRow, TimeExportRow,
  TimePayrollRow, TimePeriodRow, TimePrecloseOut,
} from '../core/api.ts';
import {
  button, dataTable, field, kv, pageTitle, selectField,
  stateForError, states, statusBadge, toast,
} from '../ui/kit.ts';
import { dayStatusBadge } from './time-calc.ts';

const KIND_KEYS = [
  'add_in', 'add_out', 'fix_type', 'exclude_event', 'reattach_event', 'fix_site_device',
  'justify_absence', 'justify_late', 'justify_early_departure', 'offsite_presence',
] as const;

function kindLabel(kind: string): string {
  const key = (`time.ckind.${kind}`) as MessageKey;
  try { return t(key); } catch { return kind; }
}
function statusBadgeOf(status: string): HTMLElement {
  const tone = status === 'applied' ? 'active'
    : ['rejected', 'cancelled', 'application_failed'].includes(status) ? 'retired' : 'draft';
  return statusBadge(tone, t((`time.cstatus.${status}`) as MessageKey));
}
function periodBadge(status: string): HTMLElement {
  const tone = status === 'closed' || status === 'archived' ? 'retired'
    : status === 'open' || status === 'reopened' ? 'active' : 'draft';
  return statusBadge(tone, t((`time.pstatus.${status}`) as MessageKey));
}
const hoursOf = (min: number) => min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}` : `${min} min`;

/** Contrôles de pré-clôture INFORMATIFS (même liste que le serveur : ni avertissement ni bloquant). */
const INFO_CONTROLS = ['expected_employees', 'employees_with_results', 'overtime_candidate_minutes', 'worked_rest_holiday_days'];

function snapshotText(s: Record<string, unknown> | null): string {
  if (!s) return '—';
  const parts: string[] = [];
  if (typeof s['status'] === 'string') parts.push(String(s['status']));
  if (typeof s['workedMinutes'] === 'number') parts.push(`${t('time.calWorked')} ${hoursOf(s['workedMinutes'] as number)}`);
  if (typeof s['absenceMinutes'] === 'number' && (s['absenceMinutes'] as number) > 0) parts.push(`${t('time.calAbsence')} ${hoursOf(s['absenceMinutes'] as number)}`);
  if (typeof s['justifiedCategory'] === 'string' && s['justifiedCategory']) parts.push(`${t('time.justified')} : ${String(s['justifiedCategory'])}`);
  if (typeof s['version'] === 'number') parts.push(`v${s['version']}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

// ---------------------------------------------------------------------------
// Formulaire de déclaration (ESS et tiers)
// ---------------------------------------------------------------------------

function requestForm(session: Session, opts: { forOthers: boolean; onDone: () => void }): HTMLElement {
  const date = field('time.calDate', { type: 'date', required: true });
  date.input.value = toIsoDate(new Date());
  const kindSel = selectField('time.cKind', KIND_KEYS.map((k) => ({ value: k, label: kindLabel(k) })));
  const motive = field('time.cMotive', { required: true });
  const localTime = field('time.cLocalTime', { placeholder: '17:00' });
  const category = field('time.cCategory', { placeholder: 'maladie' });
  const minutes = field('time.cMinutes', { type: 'number' });
  const fileWrap = h('div', { class: 'field' },
    h('label', {}, t('time.cAttachment')),
    h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg' }));
  const fileInput = fileWrap.querySelector('input') as HTMLInputElement;
  const sensWrap = h('label', { class: 'field' },
    h('input', { type: 'checkbox' }), ` ${t('time.cSensitive')}`);
  const sensInput = sensWrap.querySelector('input') as HTMLInputElement;
  let employees: Array<{ value: string; label: string }> = [];
  const empSel = selectField('emp.name', []);
  empSel.wrap.style.display = 'none';

  const syncVisibility = (): void => {
    const k = kindSel.select.value;
    localTime.wrap.style.display = k === 'add_in' || k === 'add_out' ? '' : 'none';
    const needsCat = k.startsWith('justify_') || k === 'offsite_presence';
    category.wrap.style.display = needsCat ? '' : 'none';
    minutes.wrap.style.display = needsCat ? '' : 'none';
  };
  kindSel.select.addEventListener('change', syncVisibility);
  syncVisibility();

  if (opts.forOthers && session.hasPermission('employees.view')) {
    void session.api.call<{ items: EmployeeListItem[] }>('employees', { query: { limit: 200 } }).then((res) => {
      employees = res.items.map((e) => ({ value: e.id, label: `${e.matricule} — ${e.firstName} ${e.lastName}` }));
      empSel.select.replaceChildren(...employees.map((o) => h('option', { value: o.value }, o.label)));
      empSel.wrap.style.display = '';
    }).catch(() => undefined);
  }

  const submitBtn = button(t('time.newRequest'), null, { variant: 'primary', type: 'submit' });
  const form = h('form', { class: 'filters' },
    ...(opts.forOthers ? [empSel.wrap] : []),
    date.wrap, kindSel.wrap, motive.wrap, localTime.wrap, category.wrap, minutes.wrap,
    fileWrap, sensWrap, submitBtn) as HTMLFormElement;
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    void (async () => {
      try {
        const k = kindSel.select.value;
        const payload: Record<string, unknown> = {};
        if (k === 'add_in' || k === 'add_out') payload['localTime'] = localTime.input.value.trim();
        if (k.startsWith('justify_') || k === 'offsite_presence') {
          payload['category'] = category.input.value.trim();
          if (minutes.input.value !== '') payload['minutes'] = Number(minutes.input.value);
        }
        const { id } = await session.api.call<{ id: string }>('timeCorrectionCreate', {
          body: {
            ...(opts.forOthers && empSel.select.value ? { employeeId: empSel.select.value } : {}),
            workDate: date.input.value, kind: k, motive: motive.input.value.trim(), payload,
          },
        });
        toast(t('time.cCreated'));
        const file = fileInput.files?.[0];
        if (file) {
          const buf = new Uint8Array(await file.arrayBuffer());
          let bin = '';
          for (const b of buf) bin += String.fromCharCode(b);
          await session.api.call('timeCorrectionAttach', {
            params: { id },
            body: {
              filename: file.name, mime: file.type || 'application/pdf',
              contentBase64: btoa(bin), sensitive: sensInput.checked,
            },
          });
        }
        const sub = await session.api.call<{ version: number }>('timeCorrectionSubmit', { params: { id } });
        toast(t('time.cSubmitted', { version: sub.version }));
        opts.onDone();
      } catch (e) {
        toast((e as ApiError).message, 'err');
      } finally {
        submitBtn.disabled = false;
      }
    })();
  });
  return h('div', { class: 'glass card' }, form);
}

// ---------------------------------------------------------------------------
// Tableau de demandes (partagé ESS / file d'équipe)
// ---------------------------------------------------------------------------

function requestsTable(session: Session, items: TimeCorrectionRow[], opts: {
  canDecide: boolean; canApply: boolean; canCancel: boolean; reload: () => void;
}): HTMLElement {
  const act = (label: string, fn: () => Promise<void>): HTMLButtonElement =>
    button(label, async () => {
      try {
        await fn();
        opts.reload();
      } catch (e) {
        toast((e as ApiError).message, 'err');
      }
    }, { variant: 'ghost' });
  return dataTable<TimeCorrectionRow>({
    columns: [
      { key: 'd', labelKey: 'time.calDate', render: (r) => h('a', { href: `#/time/results/${r.employeeId}/${r.workDate}`, class: 'mono' }, r.workDate) },
      { key: 'who', labelKey: 'emp.name', render: (r) => `${r.matricule} — ${r.firstName} ${r.lastName}` },
      { key: 'k', labelKey: 'time.cKind', render: (r) => kindLabel(r.kind) },
      { key: 'o', labelKey: 'time.historyMotive', render: (r) => `${t((`time.corigin.${r.origin}`) as MessageKey)} · ${r.motive}` },
      { key: 'v', labelKey: 'time.cVersion', render: (r) => h('span', { class: 'mono' }, `v${r.version}`) },
      { key: 's', labelKey: 'time.calStatus', render: (r) => statusBadgeOf(r.status) },
      {
        key: 'ba', labelKey: 'time.cBefore',
        render: (r) => `${snapshotText(r.beforeSnapshot)} → ${snapshotText(r.afterSnapshot)}`,
      },
      { key: 'att', labelKey: 'time.cAttachments', render: (r) => String(r.attachmentCount) },
      {
        key: 'act', labelKey: 'app.actions',
        render: (r) => {
          const wrap = h('span', { class: 'filters' });
          if (opts.canDecide && r.status === 'submitted') {
            wrap.appendChild(act(t('time.cApprove'), async () => {
              const out = await session.api.call<{ status: string; applied?: boolean; applicationError?: string | null }>(
                'timeCorrectionDecide', { params: { id: r.id }, body: { action: 'approve' } });
              if (out.applied === true) toast(t('time.cApplied'));
              else if (out.status === 'approved') toast(t('time.cApplyFailed', { error: out.applicationError ?? '' }), 'err');
              else toast(t('time.cDecided', { status: out.status }));
            }));
            wrap.appendChild(act(t('time.cReject'), async () => {
              await session.api.call('timeCorrectionDecide', { params: { id: r.id }, body: { action: 'reject' } });
              toast(t('time.cDecided', { status: t('time.cstatus.rejected') }));
            }));
            wrap.appendChild(act(t('time.cReturn'), async () => {
              await session.api.call('timeCorrectionDecide', { params: { id: r.id }, body: { action: 'return' } });
              toast(t('time.cDecided', { status: t('time.cstatus.returned') }));
            }));
          }
          if (opts.canApply && (r.status === 'approved' || r.status === 'application_failed')) {
            wrap.appendChild(act(t('time.cApply'), async () => {
              await session.api.call('timeCorrectionApply', { params: { id: r.id } });
              toast(t('time.cApplied'));
            }));
          }
          if (opts.canCancel && ['draft', 'returned', 'submitted'].includes(r.status)) {
            wrap.appendChild(act(t('time.cCancel'), async () => {
              await session.api.call('timeCorrectionCancel', { params: { id: r.id } });
              toast(t('time.cCancelled'));
            }));
          }
          return wrap;
        },
      },
    ],
    rows: items,
  });
}

export async function timeMyRequestsPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('time.myRequestsTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.myRequestsHint')));
  const zone = h('div', {});
  root.appendChild(requestForm(session, { forOthers: false, onDone: () => void load() }));
  root.appendChild(zone);
  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: TimeCorrectionRow[] }>('timeCorrectionsMine');
      zone.replaceChildren(res.items.length === 0 ? states.empty()
        : requestsTable(session, res.items, { canDecide: false, canApply: false, canCancel: true, reload: () => void load() }));
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }
  await load();
  return root;
}

export async function timeRequestsPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('time.requestsTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.requestsHint')));
  const canApply = session.hasPermission('time.correction_admin');
  if (session.hasPermission('time.correction_request') || canApply) {
    root.appendChild(requestForm(session, { forOthers: true, onDone: () => void load() }));
  }
  const statusSel = selectField('time.calStatus', [
    { value: 'submitted', label: t('time.cstatus.submitted') },
    { value: '', label: '—' },
    { value: 'approved', label: t('time.cstatus.approved') },
    { value: 'application_failed', label: t('time.cstatus.application_failed') },
    { value: 'applied', label: t('time.cstatus.applied') },
    { value: 'rejected', label: t('time.cstatus.rejected') },
    { value: 'draft', label: t('time.cstatus.draft') },
  ]);
  const go = button(t('app.search'), null, { variant: 'primary', type: 'submit' });
  const filters = h('form', { class: 'filters' }, statusSel.wrap, go) as HTMLFormElement;
  root.appendChild(h('div', { class: 'glass card' }, filters));
  const zone = h('div', {});
  root.appendChild(zone);
  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: TimeCorrectionRow[] }>('timeCorrections', {
        query: { status: statusSel.select.value || undefined, limit: 100 },
      });
      zone.replaceChildren(res.items.length === 0 ? states.empty()
        : requestsTable(session, res.items, { canDecide: true, canApply, canCancel: false, reload: () => void load() }));
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }
  filters.addEventListener('submit', (ev) => { ev.preventDefault(); void load(); });
  await load();
  return root;
}

// ---------------------------------------------------------------------------
// Périodes, pré-clôture, clôture, réouverture
// ---------------------------------------------------------------------------

export async function timePeriodsPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('time.periodsTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.periodsHint')));
  const canManage = session.hasPermission('time.period_manage');
  const canClose = session.hasPermission('time.period_close');
  const canReopen = session.hasPermission('time.period_reopen');
  const zone = h('div', {});
  const detail = h('div', {});

  if (canManage) {
    const label = field('time.pLabel', { required: true });
    const from = field('time.from', { type: 'date', required: true });
    const to = field('time.to', { type: 'date', required: true });
    const submit = button(t('time.pNew'), null, { variant: 'primary', type: 'submit' });
    const form = h('form', { class: 'filters' }, label.wrap, from.wrap, to.wrap, submit) as HTMLFormElement;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void (async () => {
        try {
          await session.api.call('timePeriodCreate', {
            body: { scopeKind: 'tenant', label: label.input.value.trim(), periodStart: from.input.value, periodEnd: to.input.value },
          });
          toast(t('app.save'));
          await load();
        } catch (e) {
          toast((e as ApiError).message, 'err');
        }
      })();
    });
    root.appendChild(h('div', { class: 'glass card' }, form));
  }
  root.appendChild(zone);
  root.appendChild(detail);

  async function showPreclose(p: TimePeriodRow): Promise<void> {
    detail.replaceChildren(states.loading());
    try {
      const pre = await session.api.call<TimePrecloseOut>('timePreclose', { params: { id: p.id } });
      const card = h('div', { class: 'glass card' },
        h('h3', {}, `${t('time.precloseTitle')} — ${p.label} (${t('time.pRevision')} ${pre.period.revision})`),
        h('p', { class: 'section-note' }, t('time.precloseHint')),
        h('p', { class: 'section-note' }, pre.closable
          ? t('time.precloseClosable')
          : t('time.precloseBlocked', { n: pre.blockers })),
        dataTable<TimePrecloseOut['controls'][number]>({
          columns: [
            {
              key: 'k', labelKey: 'time.compareField',
              render: (c) => { try { return t((`time.ctl.${c.key}`) as MessageKey); } catch { return c.key; } },
            },
            { key: 'n', labelKey: 'time.precloseCount', render: (c) => String(c.count) },
            {
              key: 'b', labelKey: 'time.calStatus',
              // Les compteurs PUREMENT informatifs (effectifs, volumes) ne sont ni
              // des avertissements ni des bloquants — même liste que le serveur.
              render: (c) => INFO_CONTROLS.includes(c.key) ? h('span', {}, '—')
                : c.count === 0 ? statusBadge('active', t('time.precloseOk'))
                  : statusBadge(c.blocking ? 'retired' : 'draft', c.blocking ? t('time.precloseBlocking') : t('time.precloseWarning')),
            },
          ],
          rows: pre.controls,
        }));
      if (canClose && p.status === 'locked') {
        const confirmWrap = h('label', { class: 'field' }, h('input', { type: 'checkbox' }), ` ${t('time.confirmWarnings')}`);
        const confirmInput = confirmWrap.querySelector('input') as HTMLInputElement;
        card.appendChild(h('div', { class: 'filters' }, confirmWrap,
          button(t('time.pClose'), async () => {
            try {
              const out = await session.api.call<{ close: TimeCloseRow }>('timePeriodClose', {
                params: { id: p.id }, body: { confirmWarnings: confirmInput.checked },
              });
              toast(t('time.pClosed', { no: out.close.closeNo }));
              detail.replaceChildren();
              await load();
            } catch (e) {
              toast((e as ApiError).message, 'err');
            }
          }, { variant: 'primary' })));
      }
      detail.replaceChildren(card);
    } catch (e) {
      detail.replaceChildren(stateForError(e as ApiError));
    }
  }

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: TimePeriodRow[] }>('timePeriods');
      zone.replaceChildren(res.items.length === 0
        ? h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('time.noPeriodYet')))
        : dataTable<TimePeriodRow>({
          columns: [
            { key: 'l', labelKey: 'time.pLabel', render: (p) => p.label },
            { key: 'r', labelKey: 'time.runPeriod', render: (p) => h('span', { class: 'mono' }, `${p.periodStart} → ${p.periodEnd}`) },
            { key: 's', labelKey: 'time.calStatus', render: (p) => periodBadge(p.status) },
            { key: 'rev', labelKey: 'time.pRevision', render: (p) => `r${p.revision}` },
            { key: 'c', labelKey: 'time.pCloses', render: (p) => String(p.closeCount) },
            {
              key: 'act', labelKey: 'app.actions',
              render: (p) => {
                const wrap = h('span', { class: 'filters' });
                const move = (status: string, label: string): void => {
                  wrap.appendChild(button(label, async () => {
                    try {
                      await session.api.call('timePeriodStatus', { params: { id: p.id }, body: { status } });
                      await load();
                    } catch (e) {
                      toast((e as ApiError).message, 'err');
                    }
                  }, { variant: 'ghost' }));
                };
                if (canManage && (p.status === 'open' || p.status === 'reopened')) move('in_review', t('time.pToReview'));
                if (canManage && (p.status === 'in_review' || p.status === 'reopened')) move('locked', t('time.pLock'));
                if (canManage && p.status === 'locked') move('in_review', t('time.pReopenReview'));
                wrap.appendChild(button(t('time.precloseTitle'), () => void showPreclose(p), { variant: 'ghost' }));
                if (canReopen && p.status === 'closed') {
                  wrap.appendChild(button(t('time.pReopen'), async () => {
                    const motive = window.prompt(t('time.pReopenMotive'));
                    if (!motive) return;
                    try {
                      await session.api.call('timePeriodReopen', { params: { id: p.id }, body: { motive } });
                      toast(t('time.pReopened'));
                      await load();
                    } catch (e) {
                      toast((e as ApiError).message, 'err');
                    }
                  }, { variant: 'ghost' }));
                }
                return wrap;
              },
            },
          ],
          rows: res.items,
        }));
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }
  await load();
  return root;
}

// ---------------------------------------------------------------------------
// Préparation paie : clôtures, variables, empreinte, exports
// ---------------------------------------------------------------------------

export async function timePayrollPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('time.payrollTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.payrollHint')));
  const canExport = session.hasPermission('time.payroll_export');
  const periodsRes = await session.api.call<{ items: TimePeriodRow[] }>('timePeriods').catch(() => ({ items: [] as TimePeriodRow[] }));
  const withCloses = periodsRes.items.filter((p) => p.closeCount > 0);
  const periodSel = selectField('time.pLabel', withCloses.map((p) => ({ value: p.id, label: `${p.label} (${p.periodStart} → ${p.periodEnd})` })));
  const go = button(t('app.search'), null, { variant: 'primary', type: 'submit' });
  const form = h('form', { class: 'filters' }, periodSel.wrap, go) as HTMLFormElement;
  root.appendChild(h('div', { class: 'glass card' }, form));
  const zone = h('div', {});
  root.appendChild(zone);

  async function loadCloses(): Promise<void> {
    const periodId = periodSel.select.value;
    if (!periodId) {
      zone.replaceChildren(h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('time.noResultYet'))));
      return;
    }
    zone.replaceChildren(states.loading());
    try {
      const closes = await session.api.call<{ items: TimeCloseRow[] }>('timePeriodCloses', { params: { id: periodId } });
      const blocks: HTMLElement[] = [];
      for (const c of closes.items) {
        const card = h('div', { class: 'glass card' },
          h('h3', {}, `${t('time.closeNo')}${c.closeNo} `, statusBadge(c.status === 'active' ? 'active' : 'retired',
            c.status === 'active' ? t('time.closeActive') : t('time.closeSuperseded'))),
          kv([
            [t('time.calStatus'), c.status === 'active' ? t('time.closeActive') : t('time.closeSuperseded')],
            [t('time.calEngine'), c.engineVersion],
            [t('time.closeFingerprint'), h('span', { class: 'mono' }, c.datasetSha256.slice(0, 24) + '…')],
            [t('time.runCounters'), `${c.employeesCount} × ${c.daysCount} (${c.resultsCount})`],
          ]));
        card.appendChild(h('div', { class: 'filters' },
          button(t('time.closeVerify'), async () => {
            try {
              const v = await session.api.call<{ match: boolean }>('timeCloseVerify', { params: { id: c.id } });
              toast(v.match ? t('time.closeVerifyOk') : t('time.closeVerifyKo'), v.match ? 'ok' : 'err');
            } catch (e) {
              toast((e as ApiError).message, 'err');
            }
          }, { variant: 'ghost' }),
          ...(canExport ? [
            button(t('time.exportCsv'), () => void generate(c.id, 'csv'), { variant: 'ghost' }),
            button(t('time.exportJson'), () => void generate(c.id, 'json'), { variant: 'ghost' }),
          ] : [])));
        // Variables préparatoires par salarié.
        try {
          const pay = await session.api.call<{ rows: TimePayrollRow[] }>('timeClosePayroll', { params: { id: c.id } });
          card.appendChild(dataTable<TimePayrollRow>({
            columns: [
              { key: 'm', labelKey: 'emp.matricule', render: (r) => h('span', { class: 'mono' }, r.matricule) },
              { key: 'n', labelKey: 'emp.name', render: (r) => `${r.firstName} ${r.lastName}` },
              { key: 'e', labelKey: 'time.expDays', render: (r) => String(r.expectedDays) },
              { key: 'p', labelKey: 'time.presDays', render: (r) => String(r.presentDays) },
              { key: 'a', labelKey: 'time.absDaysU', render: (r) => String(r.unjustifiedAbsenceDays) },
              {
                key: 'j', labelKey: 'time.justified',
                render: (r) => Object.entries(r.justified).map(([cat, s]) => `${cat} : ${s.days} j / ${hoursOf(s.minutes)}`).join(' · ') || '—',
              },
              { key: 'l', labelKey: 'time.calLate', render: (r) => hoursOf(r.lateMinutes) },
              { key: 'w', labelKey: 'time.calWorked', render: (r) => hoursOf(r.workedMinutes) },
              { key: 'nt', labelKey: 'time.calNight', render: (r) => hoursOf(r.nightMinutes) },
              { key: 'ot', labelKey: 'time.calOvertime', render: (r) => hoursOf(r.overtimeCandidateMinutes) },
              { key: 'c', labelKey: 'time.runIsRecalc', render: (r) => String(r.correctionsApplied) },
            ],
            rows: pay.rows,
          }));
        } catch { /* payroll_view absent : la carte reste utile */ }
        // Exports de la clôture.
        try {
          const exps = await session.api.call<{ items: TimeExportRow[] }>('timeCloseExports', { params: { id: c.id } });
          if (exps.items.length > 0) {
            card.appendChild(dataTable<TimeExportRow>({
              columns: [
                { key: 'f', labelKey: 'time.compareField', render: (x) => h('span', { class: 'mono' }, `${x.schemaVersion} · ${x.format} · r${x.revision}`) },
                {
                  key: 's', labelKey: 'time.calStatus',
                  render: (x) => statusBadge(x.status === 'active' ? 'active' : 'retired',
                    x.status === 'active' ? t('time.exportStatus.active') : t('time.exportStatus.superseded')),
                },
                { key: 'sha', labelKey: 'time.closeFingerprint', render: (x) => h('span', { class: 'mono' }, x.sha256.slice(0, 16) + '…') },
                { key: 'at', labelKey: 'time.calDate', render: (x) => fmtDateTime(x.generatedAt) },
                {
                  key: 'dl', labelKey: 'time.exportDownload',
                  render: (x) => canExport ? button(t('time.exportDownload'), async () => {
                    try {
                      const d = await session.api.call<{ filename: string; mime: string; contentBase64: string }>(
                        'timePayrollExportDownload', { params: { id: x.id } });
                      const bytes = Uint8Array.from(atob(d.contentBase64), (ch) => ch.charCodeAt(0));
                      const url = URL.createObjectURL(new Blob([bytes], { type: d.mime }));
                      const a = h('a', { href: url, download: d.filename }) as HTMLAnchorElement;
                      a.click();
                      URL.revokeObjectURL(url);
                    } catch (e) {
                      toast((e as ApiError).message, 'err');
                    }
                  }, { variant: 'ghost' }) : h('span', {}, '—'),
                },
              ],
              rows: exps.items,
            }));
          }
        } catch { /* liste facultative */ }
        blocks.push(card);
      }
      zone.replaceChildren(...(blocks.length > 0 ? blocks
        : [h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('time.noResultYet')))]));
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void loadCloses()));
    }
  }
  async function generate(closeId: string, format: 'csv' | 'json'): Promise<void> {
    try {
      const out = await session.api.call<{ export: { revision: number }; reused: boolean }>(
        'timeCloseExportCreate', { params: { id: closeId }, body: { format } });
      toast(out.reused ? t('time.exportReused') : t('time.exportGenerated', { rev: out.export.revision }));
      await loadCloses();
    } catch (e) {
      toast((e as ApiError).message, 'err');
    }
  }
  form.addEventListener('submit', (ev) => { ev.preventDefault(); void loadCloses(); });
  if (withCloses.length > 0) await loadCloses();
  else zone.appendChild(h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('time.noResultYet'))));
  return root;
}

export type { TimeCorrectionDetail };
