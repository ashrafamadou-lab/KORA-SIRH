/**
 * Paie brute (E12.1 via PWA) — trois écrans :
 *  - PÉRIODES : calendriers, périodes (la date de paie date la résolution E4),
 *    cycle contrôlé, exécution du calcul, historique des exécutions ;
 *  - RUBRIQUES & STRUCTURES : nature explicite (imposable, cotisable), versions
 *    DATÉES et immuables, valorisation (montant, taux sur clé E4, formule) ;
 *  - CALCULS : simulation SANS écriture, résultats versionnés, explication
 *    LIGNE PAR LIGNE (trace, entrées, paramètres E4 avec date d'effet),
 *    comparaison de deux versions.
 * RÈGLES : aucune donnée de paie hors ligne ; masquer un bouton n'est jamais la
 * sécurité ; E12.1 s'arrête au BRUT et aux ASSIETTES.
 */
import { h } from '../core/dom.ts';
import { t, getLocale, type MessageKey } from '../core/i18n.ts';
import { fmtDateTime } from '../core/format.ts';
import type { Session } from '../core/session.ts';
import type {
  ApiError, PayrollComparisonOut, PayrollLine, PayrollPeriodRow, PayrollResultDetailOut,
  PayrollResultRow, PayrollRubricRow, PayrollRunRow, PayrollSimulationOut,
} from '../core/api.ts';
import {
  button, dataTable, field, kv, pageTitle, selectField, stateForError, states, statusBadge, toast,
} from '../ui/kit.ts';

function tk(prefix: string, key: string): string {
  const k = (`${prefix}.${key}`) as MessageKey;
  try { return t(k); } catch { return key; }
}
const money = (v: number | string | null): string =>
  v === null ? '—' : (Math.round(Number(v) * 10000) / 10000).toString();

function periodBadge(status: string): HTMLElement {
  const tone = status === 'open' || status === 'reopened' ? 'active'
    : status === 'validated' ? 'draft' : status === 'locked' ? 'draft' : 'retired';
  return statusBadge(tone, tk('pay.st', status));
}

/** Trace d'évaluation : l'explication ligne par ligne, dans l'ordre des étapes. */
function traceTable(line: PayrollLine): HTMLElement {
  const wrap = h('div', {});
  wrap.appendChild(h('h3', { class: 'section-title' }, `${t('pay.trace')} — ${line.code}`));
  wrap.appendChild(dataTable<PayrollLine['trace'][number]>({
    columns: [
      { key: 's', labelKey: 'pay.traceStep', render: (s) => String(s.step) },
      { key: 'o', labelKey: 'pay.traceOp', render: (s) => s.op },
      { key: 'd', labelKey: 'pay.traceDetail', render: (s) => h('span', { class: 'mono' }, s.detail) },
      { key: 'v', labelKey: 'pay.traceValue', render: (s) => money(s.value) },
    ],
    rows: line.trace,
  }));
  const params = Object.entries(line.paramsUsed);
  if (params.length > 0) {
    wrap.appendChild(h('p', { class: 'section-note' },
      `${t('pay.paramsUsed')} : ${params.map(([k, p]) => `${k} = ${p.value} (${t('pay.effectiveFrom')} ${p.effectiveFrom ?? '—'})`).join(' · ')}`));
  }
  const inputs = Object.entries(line.inputsUsed);
  if (inputs.length > 0) {
    wrap.appendChild(h('p', { class: 'section-note' },
      `${t('pay.inputsUsed')} : ${inputs.map(([k, v]) => `${k} = ${v}`).join(' · ')}`));
  }
  return wrap;
}

function linesTable(lines: PayrollLine[], locale: string, onExplain: (l: PayrollLine) => void): HTMLElement {
  return dataTable<PayrollLine>({
    columns: [
      { key: 'c', labelKey: 'pay.rubric', render: (l) => `${l.code} — ${locale === 'en' ? l.labelEn : l.labelFr}` },
      { key: 'k', labelKey: 'pay.kind', render: (l) => tk('pay.kind', l.kind) },
      { key: 'v', labelKey: 'pay.valuation', render: (l) => tk('pay.val', l.valuation) },
      { key: 'b', labelKey: 'pay.base', render: (l) => money(l.base) },
      { key: 'r', labelKey: 'pay.rate', render: (l) => money(l.rate) },
      { key: 'q', labelKey: 'pay.quantity', render: (l) => money(l.quantity) },
      {
        key: 'f', labelKey: 'pay.taxable',
        render: (l) => h('span', {}, `${l.taxable ? t('pay.yes') : t('pay.no')} / ${l.cotisable ? t('pay.yes') : t('pay.no')}`),
      },
      { key: 'a', labelKey: 'pay.amount', render: (l) => h('span', { class: 'mono' }, money(l.amount)) },
      {
        key: 'x', labelKey: 'app.actions',
        render: (l) => button(t('pay.explain'), () => onExplain(l), { variant: 'ghost' }),
      },
    ],
    rows: lines,
  });
}

// ---------------------------------------------------------------------------
// Périodes de paie
// ---------------------------------------------------------------------------

export async function payrollPeriodsPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('pay.periodsTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('pay.periodsHint')));
  const canManage = session.hasPermission('payroll.calendar_manage');
  const canRun = session.hasPermission('payroll.run');
  const zone = h('div', {});
  const detail = h('div', {});

  let calendars: Array<{ id: string; code: string }> = [];
  try {
    calendars = (await session.api.call<{ items: Array<{ id: string; code: string }> }>('payrollCalendars')).items;
  } catch (e) {
    root.appendChild(stateForError(e as ApiError));
    return root;
  }

  if (canManage) {
    const calCode = field('pay.calendar', { placeholder: 'MENS' });
    const freq = selectField('pay.frequency', [
      { value: 'monthly', label: t('pay.freq.monthly') },
      { value: 'biweekly', label: t('pay.freq.biweekly') },
      { value: 'weekly', label: t('pay.freq.weekly') },
    ]);
    const calBtn = button(t('pay.newCalendar'), async () => {
      try {
        await session.api.call('payrollCalendarCreate', {
          body: {
            code: calCode.input.value.trim().toUpperCase(), labelFr: calCode.input.value.trim(),
            labelEn: calCode.input.value.trim(), frequency: freq.select.value,
          },
        });
        toast(t('app.save'));
        location.reload();
      } catch (e) { toast((e as ApiError).message, 'err'); }
    }, { variant: 'ghost' });
    root.appendChild(h('div', { class: 'glass card' }, h('div', { class: 'filters' }, calCode.wrap, freq.wrap, calBtn)));

    if (calendars.length > 0) {
      const cal = selectField('pay.calendar', calendars.map((c) => ({ value: c.id, label: c.code })));
      const label = field('pay.label', { required: true });
      const from = field('pay.from', { type: 'date', required: true });
      const to = field('pay.to', { type: 'date', required: true });
      const payDate = field('pay.payDate', { type: 'date', required: true });
      const submit = button(t('pay.newPeriod'), null, { variant: 'primary', type: 'submit' });
      const form = h('form', { class: 'filters' }, cal.wrap, label.wrap, from.wrap, to.wrap, payDate.wrap, submit) as HTMLFormElement;
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        void (async () => {
          try {
            await session.api.call('payrollPeriodCreate', {
              body: {
                calendarId: cal.select.value, label: label.input.value.trim(),
                periodStart: from.input.value, periodEnd: to.input.value, payDate: payDate.input.value,
              },
            });
            toast(t('app.save'));
            await load();
          } catch (e) { toast((e as ApiError).message, 'err'); }
        })();
      });
      root.appendChild(h('div', { class: 'glass card' }, form));
    }
  }
  root.appendChild(zone);
  root.appendChild(detail);

  async function showRuns(p: PayrollPeriodRow): Promise<void> {
    detail.replaceChildren(states.loading());
    try {
      const runs = await session.api.call<{ items: PayrollRunRow[] }>('payrollPeriodRuns', { params: { id: p.id } });
      const card = h('div', { class: 'glass card' }, h('h3', { class: 'section-title' }, `${p.label} — ${t('pay.runs')}`));
      if (runs.items.length === 0) card.appendChild(h('p', { class: 'section-note' }, t('pay.noResult')));
      else {
        card.appendChild(dataTable<PayrollRunRow>({
          columns: [
            { key: 'd', labelKey: 'time.calDate', render: (r) => fmtDateTime(r.startedAt) },
            { key: 'r', labelKey: 'pay.runReason', render: (r) => r.reason },
            { key: 's', labelKey: 'pay.status', render: (r) => statusBadge(r.status === 'completed' ? 'active' : 'retired', r.status) },
            { key: 'n', labelKey: 'pay.currentResults', render: (r) => `${r.resultsCount} / ${r.employeesCount}` },
            { key: 'e', labelKey: 'pay.engine', render: (r) => h('span', { class: 'mono' }, r.engineVersion) },
            { key: 'f', labelKey: 'pay.fingerprint', render: (r) => h('span', { class: 'mono' }, r.fingerprint ? `${r.fingerprint.slice(0, 16)}…` : '—') },
            { key: 'c', labelKey: 'pay.closes', render: (r) => `${r.timeCloseId ? 'E10' : '—'} / ${r.leaveCloseId ? 'E11' : '—'}` },
          ],
          rows: runs.items,
        }));
      }
      detail.replaceChildren(card);
    } catch (e) { detail.replaceChildren(stateForError(e as ApiError)); }
  }

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: PayrollPeriodRow[] }>('payrollPeriods');
      if (res.items.length === 0) {
        zone.replaceChildren(h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('pay.noPeriod'))));
        return;
      }
      zone.replaceChildren(dataTable<PayrollPeriodRow>({
        columns: [
          { key: 'l', labelKey: 'pay.label', render: (p) => p.label },
          { key: 'c', labelKey: 'pay.calendar', render: (p) => h('span', { class: 'mono' }, p.calendarCode) },
          { key: 'p', labelKey: 'pay.period', render: (p) => h('span', { class: 'mono' }, `${p.periodStart} → ${p.periodEnd}`) },
          { key: 'd', labelKey: 'pay.payDate', render: (p) => h('span', { class: 'mono' }, p.payDate) },
          { key: 's', labelKey: 'pay.status', render: (p) => periodBadge(p.status) },
          { key: 'r', labelKey: 'pay.revision', render: (p) => `r${p.revision}` },
          { key: 'n', labelKey: 'pay.currentResults', render: (p) => String(p.currentResults) },
          {
            key: 'a', labelKey: 'app.actions',
            render: (p) => {
              const wrap = h('span', { class: 'filters' });
              wrap.appendChild(button(t('pay.runs'), () => void showRuns(p), { variant: 'ghost' }));
              if (canRun && ['open', 'locked', 'reopened'].includes(p.status)) {
                wrap.appendChild(button(t('pay.run'), async () => {
                  const reason = window.prompt(t('pay.runReason'));
                  if (!reason) return;
                  try {
                    const out = await session.api.call<{ resultsCount: number; fingerprint: string }>('payrollRun', {
                      body: { periodId: p.id, reason },
                    });
                    toast(t('pay.runDone', { n: out.resultsCount, fp: out.fingerprint.slice(0, 12) }));
                    await load();
                  } catch (e) { toast((e as ApiError).message, 'err'); }
                }, { variant: 'primary' }));
              }
              if (canRun && p.status === 'open') wrap.appendChild(statusButton(p, 'locked', t('pay.lock')));
              if (canRun && (p.status === 'locked' || p.status === 'reopened')) {
                wrap.appendChild(statusButton(p, 'validated', t('pay.validate')));
              }
              if (canRun && p.status === 'validated') {
                wrap.appendChild(button(t('pay.reopen'), async () => {
                  const reason = window.prompt(t('pay.reopenReason'));
                  if (!reason || reason.trim().length < 3) return;
                  try {
                    await session.api.call('payrollPeriodReopen', { params: { id: p.id }, body: { reason: reason.trim() } });
                    toast(t('pay.reopenRequested'));
                    await load();
                  } catch (e) { toast((e as ApiError).message, 'err'); }
                }, { variant: 'ghost' }));
              }
              return wrap;
            },
          },
        ],
        rows: res.items,
      }));
    } catch (e) { zone.replaceChildren(stateForError(e as ApiError, () => void load())); }
  }

  function statusButton(p: PayrollPeriodRow, status: string, label: string): HTMLElement {
    return button(label, async () => {
      try {
        await session.api.call('payrollPeriodStatus', { params: { id: p.id }, body: { status } });
        toast(t('pay.statusChanged'));
        await load();
      } catch (e) { toast((e as ApiError).message, 'err'); }
    }, { variant: 'ghost' });
  }

  await load();
  return root;
}

// ---------------------------------------------------------------------------
// Rubriques et structures
// ---------------------------------------------------------------------------

export async function payrollRubricsPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('pay.rubricsTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('pay.rubricsHint')));
  const locale = getLocale();
  const zone = h('div', {});
  root.appendChild(zone);

  try {
    const structures = await session.api.call<{ items: Array<{ code: string; labelFr: string; labelEn: string; status: string; rubrics: Array<{ code: string; sequence: number }> }> }>('payrollStructures');
    const sCard = h('div', { class: 'glass card' }, h('h3', { class: 'section-title' }, t('pay.structures')));
    if (structures.items.length === 0) sCard.appendChild(h('p', { class: 'section-note' }, t('pay.noRubric')));
    for (const s of structures.items) {
      sCard.appendChild(kv([
        [locale === 'en' ? s.labelEn : s.labelFr, h('span', { class: 'mono' }, s.code)],
        [t('pay.status'), statusBadge(s.status === 'active' ? 'active' : 'draft', s.status)],
        [t('pay.rubric'), s.rubrics.map((r) => r.code).join(' · ') || '—'],
      ]));
    }
    zone.appendChild(sCard);

    const rubrics = await session.api.call<{ items: PayrollRubricRow[] }>('payrollRubrics');
    const rCard = h('div', { class: 'glass card' }, h('h3', { class: 'section-title' }, t('pay.rubric')));
    if (rubrics.items.length === 0) {
      rCard.appendChild(h('p', { class: 'section-note' }, t('pay.noRubric')));
    } else {
      rCard.appendChild(dataTable<PayrollRubricRow>({
        columns: [
          { key: 'c', labelKey: 'pay.rubric', render: (r) => `${r.code} — ${locale === 'en' ? r.labelEn : r.labelFr}` },
          { key: 'k', labelKey: 'pay.kind', render: (r) => tk('pay.kind', r.kind) },
          { key: 'x', labelKey: 'pay.taxable', render: (r) => r.taxable ? t('pay.yes') : t('pay.no') },
          { key: 'y', labelKey: 'pay.cotisable', render: (r) => r.cotisable ? t('pay.yes') : t('pay.no') },
          { key: 's', labelKey: 'pay.status', render: (r) => statusBadge(r.status === 'active' ? 'active' : 'draft', r.status) },
          { key: 'u', labelKey: 'pay.used', render: (r) => r.used ? t('pay.yes') : t('pay.no') },
          {
            key: 'v', labelKey: 'pay.versions',
            render: (r) => h('span', { class: 'mono' },
              r.versions.map((v) => `v${v.version} ${v.effectiveFrom} ${tk('pay.val', v.valuation)}`).join(' · ') || '—'),
          },
          {
            key: 'p', labelKey: 'pay.paramKey',
            render: (r) => h('span', { class: 'mono' },
              [...new Set(r.versions.flatMap((v) => [v.rateParamKey, v.capParamKey].filter(Boolean)))].join(' · ') || '—'),
          },
        ],
        rows: rubrics.items,
      }));
    }
    zone.appendChild(rCard);
  } catch (e) {
    zone.replaceChildren(stateForError(e as ApiError));
  }
  return root;
}

// ---------------------------------------------------------------------------
// Calculs : simulation, résultats versionnés, explication, comparaison
// ---------------------------------------------------------------------------

export async function payrollResultsPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('pay.resultsTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('pay.resultsHint')));
  const locale = getLocale();
  const canSimulate = session.hasPermission('payroll.simulate');
  const zone = h('div', {});
  const detail = h('div', {});

  let periods: PayrollPeriodRow[] = [];
  try {
    periods = (await session.api.call<{ items: PayrollPeriodRow[] }>('payrollPeriods')).items;
  } catch (e) {
    root.appendChild(stateForError(e as ApiError));
    return root;
  }
  if (periods.length === 0) {
    root.appendChild(h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('pay.noPeriod'))));
    return root;
  }
  const periodSel = selectField('pay.selectPeriod', periods.map((p) => ({ value: p.id, label: `${p.label} (${p.periodStart} → ${p.periodEnd})` })));
  const empId = field('pay.employeeId', { placeholder: 'UUID' });
  const go = button(t('app.search'), null, { variant: 'primary', type: 'submit' });
  const simBtn = canSimulate ? button(t('pay.simulate'), () => void simulate(), { variant: 'ghost' }) : null;
  const form = h('form', { class: 'filters' }, periodSel.wrap, empId.wrap, go) as HTMLFormElement;
  if (simBtn) form.appendChild(simBtn);
  root.appendChild(h('div', { class: 'glass card' }, form));
  root.appendChild(zone);
  root.appendChild(detail);

  function explain(line: PayrollLine): void {
    detail.replaceChildren(h('div', { class: 'glass card' }, traceTable(line)));
  }

  async function simulate(): Promise<void> {
    if (!empId.input.value.trim()) { toast(t('pay.noSimulation'), 'err'); return; }
    zone.replaceChildren(states.loading());
    try {
      const out = await session.api.call<PayrollSimulationOut>('payrollSimulate', {
        body: { periodId: periodSel.select.value, employeeId: empId.input.value.trim() },
      });
      const s = out.simulation;
      const card = h('div', { class: 'glass card' });
      card.appendChild(h('h3', { class: 'section-title' }, `${s.periodLabel} — ${t('pay.simulate')}`));
      card.appendChild(h('p', { class: 'section-note' }, t('pay.simulationNote')));
      card.appendChild(kv([
        [t('pay.gross'), h('span', { class: 'mono' }, `${money(s.gross)} ${s.currency}`)],
        [t('pay.taxableBase'), money(s.taxableBase)],
        [t('pay.contributableBase'), money(s.contributableBase)],
        [t('pay.payDate'), h('span', { class: 'mono' }, s.payDate)],
        [t('pay.timeClose'), h('span', { class: 'mono' }, s.timeCloseId ? `${s.timeCloseId.slice(0, 8)}…` : '—')],
        [t('pay.leaveClose'), h('span', { class: 'mono' }, s.leaveCloseId ? `${s.leaveCloseId.slice(0, 8)}…` : '—')],
        [t('pay.engine'), h('span', { class: 'mono' }, s.engineVersion)],
        [t('pay.fingerprint'), h('span', { class: 'mono' }, `${s.inputsSha256.slice(0, 24)}…`)],
      ]));
      card.appendChild(h('p', { class: 'section-note' }, t('pay.leviesNote')));
      card.appendChild(linesTable(s.lines, locale, explain));
      if (s.skipped.length > 0) {
        card.appendChild(h('p', { class: 'section-note' },
          `${t('pay.skipped')} : ${s.skipped.map((x) => `${x.code} (${x.reason})`).join(' · ')}`));
      }
      if (s.errors.length > 0) {
        card.appendChild(h('p', { class: 'error-text' },
          `${t('pay.errors')} : ${s.errors.map((x) => `${x.code} — ${x.reason}`).join(' · ')}`));
      }
      zone.replaceChildren(card);
    } catch (e) { zone.replaceChildren(stateForError(e as ApiError)); }
  }

  async function openResult(id: string, others: PayrollResultRow[]): Promise<void> {
    detail.replaceChildren(states.loading());
    try {
      const out = await session.api.call<PayrollResultDetailOut>('payrollResult', { params: { id } });
      const r = out.result;
      const card = h('div', { class: 'glass card' });
      card.appendChild(h('h3', { class: 'section-title' },
        `${r.matricule} · ${r.periodLabel} · v${r.version} `,
        statusBadge(r.isCurrent ? 'active' : 'retired', r.isCurrent ? t('pay.current') : t('pay.superseded'))));
      card.appendChild(kv([
        [t('pay.gross'), h('span', { class: 'mono' }, `${money(r.grossAmount)} ${r.currency}`)],
        [t('pay.taxableBase'), money(r.taxableBase)],
        [t('pay.contributableBase'), money(r.contributableBase)],
        [t('pay.engine'), h('span', { class: 'mono' }, r.engineVersion)],
        [t('pay.fingerprint'), h('span', { class: 'mono' }, `${r.inputsSha256.slice(0, 24)}…`)],
        [t('pay.timeClose'), h('span', { class: 'mono' }, r.timeCloseId ? `${r.timeCloseId.slice(0, 8)}…` : '—')],
        [t('pay.leaveClose'), h('span', { class: 'mono' }, r.leaveCloseId ? `${r.leaveCloseId.slice(0, 8)}…` : '—')],
      ]));
      card.appendChild(h('p', { class: 'section-note' }, t('pay.leviesNote')));
      card.appendChild(linesTable(r.lines, locale, explain));
      const params = Object.entries(r.paramsUsed);
      if (params.length > 0) {
        card.appendChild(h('p', { class: 'section-note' },
          `${t('pay.paramsUsed')} : ${params.map(([k, p]) => `${k} = ${p.value} (${p.effectiveFrom ?? '—'})`).join(' · ')}`));
      }
      const peers = others.filter((o) => o.id !== id);
      if (peers.length > 0) {
        const sel = selectField('pay.compareWith', peers.map((o) => ({ value: o.id, label: `v${o.version}` })));
        card.appendChild(h('div', { class: 'filters' }, sel.wrap,
          button(t('pay.compare'), () => void compare(id, sel.select.value), { variant: 'ghost' })));
      }
      detail.replaceChildren(card);
    } catch (e) { detail.replaceChildren(stateForError(e as ApiError)); }
  }

  async function compare(aId: string, bId: string): Promise<void> {
    try {
      const out = await session.api.call<PayrollComparisonOut>('payrollResultCompare', {
        params: { id: aId }, query: { with: bId },
      });
      const c = out.comparison;
      const card = h('div', { class: 'glass card' });
      card.appendChild(h('h3', { class: 'section-title' }, t('pay.comparison')));
      card.appendChild(kv([
        [t('pay.version'), `v${c.from.version} → v${c.to.version}`],
        [t('pay.gross'), `${money(c.from.gross)} → ${money(c.to.gross)}`],
        [t('pay.grossDelta'), h('span', { class: 'mono' }, money(c.grossDelta))],
        [t('pay.sameInputs'), c.sameInputs ? t('pay.yes') : t('pay.no')],
      ]));
      if (c.differences.length === 0) {
        card.appendChild(h('p', { class: 'section-note' }, t('pay.noDifference')));
      } else {
        card.appendChild(dataTable<PayrollComparisonOut['comparison']['differences'][number]>({
          columns: [
            { key: 'c', labelKey: 'pay.rubric', render: (d) => d.code },
            { key: 'b', labelKey: 'pay.before', render: (d) => money(d.before) },
            { key: 'a', labelKey: 'pay.after', render: (d) => money(d.after) },
            { key: 'd', labelKey: 'pay.grossDelta', render: (d) => h('span', { class: 'mono' }, money(d.delta)) },
            { key: 'k', labelKey: 'pay.difference', render: (d) => tk('pay.change', d.change) },
          ],
          rows: c.differences,
        }));
      }
      detail.replaceChildren(card);
    } catch (e) { detail.replaceChildren(stateForError(e as ApiError)); }
  }

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: PayrollResultRow[] }>('payrollPeriodResults', {
        params: { id: periodSel.select.value },
      });
      if (res.items.length === 0) {
        zone.replaceChildren(h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('pay.noResult'))));
        return;
      }
      zone.replaceChildren(dataTable<PayrollResultRow>({
        columns: [
          { key: 'm', labelKey: 'emp.matricule', render: (r) => h('span', { class: 'mono' }, r.matricule) },
          { key: 'n', labelKey: 'emp.name', render: (r) => `${r.firstName} ${r.lastName}` },
          { key: 'v', labelKey: 'pay.version', render: (r) => `v${r.version}` },
          {
            key: 'c', labelKey: 'pay.status',
            render: (r) => statusBadge(r.isCurrent ? 'active' : 'retired', r.isCurrent ? t('pay.current') : t('pay.superseded')),
          },
          { key: 'g', labelKey: 'pay.gross', render: (r) => h('span', { class: 'mono' }, `${money(r.grossAmount)} ${r.currency}`) },
          { key: 'i', labelKey: 'pay.taxableBase', render: (r) => money(r.taxableBase) },
          { key: 'o', labelKey: 'pay.contributableBase', render: (r) => money(r.contributableBase) },
          { key: 'f', labelKey: 'pay.fingerprint', render: (r) => h('span', { class: 'mono' }, `${r.inputsSha256.slice(0, 12)}…`) },
          {
            key: 'a', labelKey: 'app.actions',
            render: (r) => button(t('app.details'), () => {
              void openResult(r.id, res.items.filter((x) => x.employeeId === r.employeeId));
            }, { variant: 'ghost' }),
          },
        ],
        rows: res.items,
      }));
    } catch (e) { zone.replaceChildren(stateForError(e as ApiError, () => void load())); }
  }

  form.addEventListener('submit', (ev) => { ev.preventDefault(); void load(); });
  await load();
  return root;
}
