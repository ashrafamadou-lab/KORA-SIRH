/**
 * Moteur de présence (E10.2 via PWA) — écrans : registre quotidien (+ indicateurs),
 * calendrier d'un salarié, détail d'une journée (planifié/réalisé, chronologie,
 * paramètres appliqués à la date, anomalies, versions + comparaison), file des
 * anomalies (états contrôlés), exécutions (déclenchement, recalcul motivé,
 * prévisualisation SANS écriture), « Mes présences ».
 *
 * RÈGLES : cacher un bouton n'est JAMAIS la sécurité (le serveur tranche) ;
 * AUCUN résultat de présence n'est mis en cache hors ligne (network-only) ;
 * les minutes BRUTES sont montrées À CÔTÉ des retenues — jamais à leur place ;
 * les heures supplémentaires sont CANDIDATES : aucun taux, aucun montant.
 */
import { h } from '../core/dom.ts';
import { t, getLocale, type MessageKey } from '../core/i18n.ts';
import { fmtDateTime, toIsoDate } from '../core/format.ts';
import type { Session } from '../core/session.ts';
import type {
  ApiError, EmployeeListItem, OrgItem, OrgUnitItem,
  TimeAggregateRow, TimeAnomalyCatalogItem, TimeAnomalyItem, TimeCalcPreviewOut,
  TimeCalcRun, TimeCompareOut, TimeDayDetail, TimeDayResult, TimeDayStatus, TimeHistoryVersion,
} from '../core/api.ts';
import {
  button, dataTable, field, kv, pageTitle, selectField,
  stateForError, states, statusBadge, toast,
} from '../ui/kit.ts';

const DSTATUS_KEY: Record<TimeDayStatus, MessageKey> = {
  present: 'time.dstatus.present',
  late: 'time.dstatus.late',
  early_departure: 'time.dstatus.early_departure',
  late_and_early_departure: 'time.dstatus.late_and_early_departure',
  absent: 'time.dstatus.absent',
  partial_presence: 'time.dstatus.partial_presence',
  incomplete_punches: 'time.dstatus.incomplete_punches',
  rest_day: 'time.dstatus.rest_day',
  public_holiday: 'time.dstatus.public_holiday',
  worked_rest_day: 'time.dstatus.worked_rest_day',
  worked_public_holiday: 'time.dstatus.worked_public_holiday',
  not_scheduled: 'time.dstatus.not_scheduled',
  not_employed: 'time.dstatus.not_employed',
  suspended: 'time.dstatus.suspended',
  unresolved: 'time.dstatus.unresolved',
};
/** Ton visuel par statut — réutilise les tons existants du kit (pas de nouveau CSS). */
const DSTATUS_TONE: Record<TimeDayStatus, string> = {
  present: 'active', late: 'draft', early_departure: 'draft', late_and_early_departure: 'draft',
  absent: 'retired', partial_presence: 'draft', incomplete_punches: 'draft',
  rest_day: 'active', public_holiday: 'active', worked_rest_day: 'draft', worked_public_holiday: 'draft',
  not_scheduled: 'draft', not_employed: 'retired', suspended: 'retired', unresolved: 'retired',
};

export function dayStatusBadge(status: string): HTMLElement {
  const key = DSTATUS_KEY[status as TimeDayStatus];
  return statusBadge(DSTATUS_TONE[status as TimeDayStatus] ?? 'draft', key ? t(key) : status);
}
function severityBadge(sev: string): HTMLElement {
  const key = (`time.severity.${sev}`) as MessageKey;
  return statusBadge(sev === 'blocking' ? 'retired' : sev === 'warning' ? 'draft' : 'active', t(key));
}
function anomalyStateBadge(state: string): HTMLElement {
  const key = (`time.astate.${state}`) as MessageKey;
  return statusBadge(state === 'open' ? 'retired' : state === 'acknowledged' ? 'draft' : 'active', t(key));
}
const pad2 = (n: number) => String(n).padStart(2, '0');
function minuteLabel(m: number): string {
  const day = Math.floor(m / 1440);
  const base = m - day * 1440;
  const s = `${pad2(Math.floor(base / 60))}:${pad2(base % 60)}`;
  return day > 0 ? `${s} ${t('time.nextDay')}` : day < 0 ? `${s} (−1 j)` : s;
}
/** Minutes entières → « 7 h 05 » (affichage) — la donnée reste la minute. */
function hoursLabel(min: number): string {
  if (min === 0) return `0 ${t('time.calMinutesUnit')}`;
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  if (hh === 0) return `${mm} ${t('time.calMinutesUnit')}`;
  return `${hh} h ${pad2(mm)}`;
}
/** Brut ≠ retenu ⇒ les DEUX sont montrés (le fait mesuré n'est jamais caché). */
function rawRetained(raw: number, retained: number): string {
  if (raw === retained) return hoursLabel(retained);
  return `${hoursLabel(retained)} (${t('time.calRaw')} ${hoursLabel(raw)})`;
}
function catalogLabel(catalog: Map<string, TimeAnomalyCatalogItem>, code: string): string {
  const item = catalog.get(code);
  if (!item) return code;
  return getLocale() === 'en' ? item.labelEn : item.labelFr;
}
async function loadCatalog(session: Session): Promise<Map<string, TimeAnomalyCatalogItem>> {
  try {
    const res = await session.api.call<{ items: TimeAnomalyCatalogItem[] }>('timeAnomalyCatalog');
    return new Map(res.items.map((i) => [i.code, i]));
  } catch {
    return new Map();
  }
}
async function employeeOptions(session: Session): Promise<Array<{ value: string; label: string }> | null> {
  if (!session.hasPermission('employees.view')) return null;
  try {
    const res = await session.api.call<{ items: EmployeeListItem[] }>('employees', { query: { limit: 200 } });
    return res.items.map((e) => ({ value: e.id, label: `${e.matricule} — ${e.firstName} ${e.lastName}` }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registre quotidien
// ---------------------------------------------------------------------------

export async function timeResultsPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('time.resultsTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.resultsHint')));

  const date = field('time.calDate', { type: 'date', required: true });
  date.input.value = toIsoDate(new Date());
  const statusSel = selectField('time.calStatus', [{ value: '', label: '—' }].concat(
    (Object.keys(DSTATUS_KEY) as TimeDayStatus[]).map((s) => ({ value: s, label: t(DSTATUS_KEY[s]) })),
  ));
  let sites: OrgItem[] = [];
  let units: OrgUnitItem[] = [];
  if (session.hasPermission('org.view')) {
    sites = await session.api.call<OrgItem[]>('orgSites', { query: { limit: 200 } }).catch(() => [] as OrgItem[]);
    units = await session.api.call<OrgUnitItem[]>('orgUnits', { query: { limit: 200 } }).catch(() => [] as OrgUnitItem[]);
  }
  const siteSel = selectField('time.site', [{ value: '', label: '—' }].concat(sites.map((s) => ({ value: s.id, label: s.code }))));
  const unitSel = selectField('time.unit', [{ value: '', label: '—' }].concat(units.map((u) => ({ value: u.id, label: u.code }))));
  const refresh = button(t('app.search'), null, { variant: 'primary', type: 'submit' });
  const form = h('form', { class: 'filters' }, date.wrap, statusSel.wrap, siteSel.wrap, unitSel.wrap, refresh) as HTMLFormElement;
  root.appendChild(h('div', { class: 'glass card' }, form));
  const indicators = h('div', {});
  const zone = h('div', {});
  root.appendChild(indicators);
  root.appendChild(zone);

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    indicators.replaceChildren();
    const day = date.input.value;
    try {
      const res = await session.api.call<{ items: TimeDayResult[] }>('timeResults', {
        query: {
          date: day, status: statusSel.select.value || undefined,
          siteId: siteSel.select.value || undefined, unitId: unitSel.select.value || undefined,
          limit: 200,
        },
      });
      // Indicateurs du jour, calculés sur les lignes AFFICHÉES (retraçables à l'écran).
      const present = res.items.filter((r) => r.workedMinutes > 0).length;
      const absent = res.items.filter((r) => r.dayStatus === 'absent').length;
      const unresolved = res.items.filter((r) => r.dayStatus === 'unresolved' || r.calcState === 'error').length;
      const anomalies = res.items.reduce((s, r) => s + r.openAnomalies, 0);
      indicators.replaceChildren(h('div', { class: 'glass card' }, h('p', { class: 'section-note' },
        `${t('time.calIndicators')} : ${present} ${t('time.calPresent')} · ${absent} ${t('time.calAbsents')} · `
        + `${unresolved} ${t('time.calUnresolved')} · ${anomalies} ${t('time.calOpenAnomalies').toLowerCase()}`)));
      zone.replaceChildren(res.items.length === 0
        ? h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('time.noResultYet')))
        : dataTable<TimeDayResult>({
          columns: [
            { key: 'mat', labelKey: 'emp.matricule', render: (r) => h('span', { class: 'mono' }, r.matricule ?? '') },
            { key: 'name', labelKey: 'emp.name', render: (r) => `${r.firstName ?? ''} ${r.lastName ?? ''}` },
            { key: 'status', labelKey: 'time.calStatus', render: (r) => dayStatusBadge(r.dayStatus) },
            { key: 'worked', labelKey: 'time.calWorked', render: (r) => hoursLabel(r.workedMinutes) },
            { key: 'late', labelKey: 'time.calLate', render: (r) => rawRetained(r.lateMinutesRaw, r.lateMinutes) },
            { key: 'early', labelKey: 'time.calEarly', render: (r) => rawRetained(r.earlyDepartureMinutesRaw, r.earlyDepartureMinutes) },
            { key: 'night', labelKey: 'time.calNight', render: (r) => hoursLabel(r.nightMinutes) },
            { key: 'anoms', labelKey: 'time.calAnomalies', render: (r) => String(r.openAnomalies) },
            {
              key: 'go', labelKey: 'time.calDayLink',
              render: (r) => h('a', { href: `#/time/results/${r.employeeId}/${r.workDate}` }, t('time.calDayLink')),
            },
          ],
          rows: res.items,
        }));
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }
  form.addEventListener('submit', (ev) => { ev.preventDefault(); void load(); });
  await load();
  return root;
}

// ---------------------------------------------------------------------------
// Calendrier d'un salarié + agrégats
// ---------------------------------------------------------------------------

function calendarTable(items: TimeDayResult[], employeeId: string): HTMLElement {
  return dataTable<TimeDayResult>({
    columns: [
      { key: 'date', labelKey: 'time.calDate', render: (r) => h('span', { class: 'mono' }, r.workDate) },
      { key: 'status', labelKey: 'time.calStatus', render: (r) => dayStatusBadge(r.dayStatus) },
      { key: 'worked', labelKey: 'time.calWorked', render: (r) => hoursLabel(r.workedMinutes) },
      { key: 'late', labelKey: 'time.calLate', render: (r) => rawRetained(r.lateMinutesRaw, r.lateMinutes) },
      { key: 'early', labelKey: 'time.calEarly', render: (r) => rawRetained(r.earlyDepartureMinutesRaw, r.earlyDepartureMinutes) },
      { key: 'abs', labelKey: 'time.calAbsence', render: (r) => hoursLabel(r.absenceMinutes) },
      { key: 'night', labelKey: 'time.calNight', render: (r) => hoursLabel(r.nightMinutes) },
      { key: 'ot', labelKey: 'time.calOvertime', render: (r) => hoursLabel(r.overtimeCandidateMinutes) },
      { key: 'v', labelKey: 'time.calVersion', render: (r) => `v${r.version}` },
      {
        key: 'go', labelKey: 'time.calDayLink',
        render: (r) => h('a', { href: `#/time/results/${employeeId}/${r.workDate}` }, t('time.calDayLink')),
      },
    ],
    rows: items,
  });
}

function aggregatesCard(agg: TimeAggregateRow): HTMLElement {
  return h('div', { class: 'glass card' },
    h('h3', {}, t('time.aggTitle')),
    h('p', { class: 'section-note' }, t('time.aggHint')),
    kv([
      [t('time.aggExpected'), String(agg.expectedDays)],
      [t('time.aggPresent'), String(agg.presentDays)],
      [t('time.aggAbsent'), String(agg.absentDays)],
      [t('time.aggLate'), `${agg.lateCount} (${hoursLabel(agg.lateMinutes)})`],
      [t('time.aggWorkedH'), hoursLabel(agg.workedMinutes)],
      [t('time.aggNightH'), hoursLabel(agg.nightMinutes)],
      [t('time.aggOvertime'), hoursLabel(agg.overtimeCandidateMinutes)],
      [t('time.aggOpenAnomalies'), String(agg.openAnomalies)],
    ]),
  );
}

export async function timeEmployeeCalendarPage(session: Session, employeeId: string): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('time.calendarTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.calendarHint')));
  const today = new Date();
  const from = field('time.from', { type: 'date', required: true });
  const to = field('time.to', { type: 'date', required: true });
  from.input.value = toIsoDate(new Date(today.getFullYear(), today.getMonth(), 1));
  to.input.value = toIsoDate(today);
  const go = button(t('app.search'), null, { variant: 'primary', type: 'submit' });
  const form = h('form', { class: 'filters' }, from.wrap, to.wrap, go) as HTMLFormElement;
  root.appendChild(h('div', { class: 'glass card' }, form));
  const zone = h('div', {});
  root.appendChild(zone);

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: TimeDayResult[]; self: boolean }>('timeResultsEmployee', {
        params: { id: employeeId }, query: { from: from.input.value, to: to.input.value },
      });
      const blocks: HTMLElement[] = [];
      if (res.items.length === 0) {
        blocks.push(h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('time.noResultYet'))));
      } else {
        blocks.push(calendarTable(res.items, employeeId));
        try {
          const agg = await session.api.call<{ perEmployee: TimeAggregateRow[] }>('timeAggregates', {
            query: { from: from.input.value, to: to.input.value, employeeId },
          });
          if (agg.perEmployee[0]) blocks.push(aggregatesCard(agg.perEmployee[0]));
        } catch { /* agrégats facultatifs (portée) */ }
      }
      zone.replaceChildren(...blocks);
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }
  form.addEventListener('submit', (ev) => { ev.preventDefault(); void load(); });
  await load();
  return root;
}

// ---------------------------------------------------------------------------
// Mes présences (self)
// ---------------------------------------------------------------------------

export async function timeMyPresencePage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('time.myPresenceTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.myPresenceHint')));
  const today = new Date();
  const from = field('time.from', { type: 'date' });
  const to = field('time.to', { type: 'date' });
  from.input.value = toIsoDate(new Date(today.getTime() - 13 * 86_400_000));
  to.input.value = toIsoDate(today);
  const go = button(t('app.search'), null, { variant: 'primary', type: 'submit' });
  const form = h('form', { class: 'filters' }, from.wrap, to.wrap, go) as HTMLFormElement;
  root.appendChild(h('div', { class: 'glass card' }, form));
  const zone = h('div', {});
  root.appendChild(zone);

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ linked: boolean; items: TimeDayResult[] }>('timeResultsMine', {
        query: { from: from.input.value || undefined, to: to.input.value || undefined },
      });
      if (!res.linked) {
        zone.replaceChildren(h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('time.mineNotLinked'))));
        return;
      }
      zone.replaceChildren(res.items.length === 0
        ? h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('time.noResultYet')))
        : dataTable<TimeDayResult>({
          columns: [
            { key: 'date', labelKey: 'time.calDate', render: (r) => h('span', { class: 'mono' }, r.workDate) },
            { key: 'status', labelKey: 'time.calStatus', render: (r) => dayStatusBadge(r.dayStatus) },
            { key: 'worked', labelKey: 'time.calWorked', render: (r) => hoursLabel(r.workedMinutes) },
            { key: 'late', labelKey: 'time.calLate', render: (r) => rawRetained(r.lateMinutesRaw, r.lateMinutes) },
            { key: 'night', labelKey: 'time.calNight', render: (r) => hoursLabel(r.nightMinutes) },
            {
              key: 'go', labelKey: 'time.calDayLink',
              render: (r) => h('a', { href: `#/time/results/${r.employeeId}/${r.workDate}` }, t('time.calDayLink')),
            },
          ],
          rows: res.items,
        }));
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }
  form.addEventListener('submit', (ev) => { ev.preventDefault(); void load(); });
  await load();
  return root;
}

// ---------------------------------------------------------------------------
// Détail d'une journée : planifié/réalisé, chronologie, paramètres, anomalies, versions
// ---------------------------------------------------------------------------

export async function timeDayDetailPage(session: Session, employeeId: string, date: string): Promise<HTMLElement> {
  const root = h('div', {});
  const zone = h('div', {});
  root.appendChild(pageTitle(`${t('time.calDate')} ${date}`));
  root.appendChild(zone);
  const catalog = await loadCatalog(session);
  const canManage = session.hasPermission('time.anomalies_manage');

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const d = await session.api.call<TimeDayDetail>('timeResultDay', { query: { employeeId, date } });
      const r = d.result;
      const blocks: HTMLElement[] = [];

      // Statut + état de calcul + version.
      const head = h('div', { class: 'glass card' },
        h('div', { class: 'filters' },
          dayStatusBadge(r.dayStatus),
          h('span', { class: 'mono' }, `v${r.version} / ${d.versionCount}`),
          h('span', { class: 'mono' }, r.engineVersion),
          h('span', { class: 'mono' }, r.tz)),
        r.calcState === 'error'
          ? h('p', { class: 'section-note' }, t('time.calErrorNote', { note: r.calcNote ?? '' }))
          : h('span', {}),
      );
      blocks.push(head);

      // Planifié vs réalisé.
      const plannedText = r.plannedRest
        ? t('time.calRestFlag')
        : r.plannedStartMinute !== null && r.plannedEndMinute !== null
          ? `${minuteLabel(r.plannedStartMinute)} → ${minuteLabel(r.plannedEndMinute)}`
            + (r.plannedBreakStartMinute !== null && r.plannedBreakEndMinute !== null
              ? ` · ${t('time.calBreak')} ${minuteLabel(r.plannedBreakStartMinute)}–${minuteLabel(r.plannedBreakEndMinute)}`
              : '')
          : t('time.calNoPlanned');
      const flags: string[] = [];
      if (r.holiday) flags.push(t('time.calHolidayFlag'));
      if (r.exceptionKind !== null) flags.push(t('time.calExceptionFlag', { kind: r.exceptionKind }));
      blocks.push(h('div', { class: 'glass card' },
        h('h3', {}, `${t('time.calPlanned')} / ${t('time.calRealized')}`),
        kv([
          [t('time.calPlanned'), plannedText + (flags.length > 0 ? ` — ${flags.join(' · ')}` : '')
            + (r.scheduleModelCode !== null ? ` (${r.scheduleModelCode} v${r.scheduleModelVersion ?? '—'})` : '')],
          [t('time.calFirstIn'), r.firstIn === null ? '—' : fmtDateTime(r.firstIn)],
          [t('time.calLastOut'), r.lastOut === null ? '—' : fmtDateTime(r.lastOut)],
          [t('time.calPeriods'), r.workPeriods.length === 0 ? '—'
            : r.workPeriods.map((p) => `${minuteLabel(p.startMinute)} → ${minuteLabel(p.endMinute)}`).join(' · ')],
          [t('time.calPresence'), hoursLabel(r.presenceMinutes)],
          [t('time.calWorked'), hoursLabel(r.workedMinutes)],
          [t('time.calBreak'), hoursLabel(r.breakMinutes)],
          [t('time.calLate'), rawRetained(r.lateMinutesRaw, r.lateMinutes)],
          [t('time.calEarly'), rawRetained(r.earlyDepartureMinutesRaw, r.earlyDepartureMinutes)],
          [t('time.calAbsence'), hoursLabel(r.absenceMinutes)],
          [t('time.calNight'), hoursLabel(r.nightMinutes)],
          [t('time.calRestWorked'), hoursLabel(r.restDayMinutes)],
          [t('time.calHolidayWorked'), hoursLabel(r.holidayMinutes)],
          [t('time.calOvertime'), hoursLabel(r.overtimeCandidateMinutes)],
        ]),
      ));

      // Chronologie des pointages (verité de la collecte, marquage « retenu »).
      const used = new Set(r.usedEventIds);
      blocks.push(h('div', { class: 'glass card' },
        h('h3', {}, t('time.calChronology')),
        d.events.length === 0 ? h('p', { class: 'section-note' }, '—')
          : dataTable<TimeDayDetail['events'][number]>({
            columns: [
              { key: 'd', labelKey: 'time.calDate', render: (ev) => h('span', { class: 'mono' }, `${ev.localDate} ${ev.localTime.slice(0, 5)}`) },
              { key: 'type', labelKey: 'time.eventType', render: (ev) => t((`time.event.${ev.eventType}`) as MessageKey) },
              { key: 'site', labelKey: 'time.site', render: (ev) => ev.siteCode ?? '—' },
              { key: 'device', labelKey: 'time.device', render: (ev) => ev.deviceCode ?? '—' },
              {
                key: 'used', labelKey: 'time.calUsed',
                render: (ev) => statusBadge(used.has(ev.id) ? 'active' : 'draft', used.has(ev.id) ? t('time.calUsed') : t('time.calNotUsed')),
              },
            ],
            rows: d.events,
          }),
      ));

      // Paramètres appliqués À LA DATE (provenance et version exactes).
      blocks.push(h('div', { class: 'glass card' },
        h('h3', {}, t('time.calParams')),
        kv(Object.entries(r.paramsUsed).map(([key, p]) => [
          key,
          `${String(p.value)} — ${t((`time.calParamSource.${p.source}`) as MessageKey)}`
          + (p.effectiveFrom !== null ? ` (${p.effectiveFrom})` : ''),
        ])),
      ));

      // Anomalies de la version courante, avec actions d'état contrôlées.
      const anomZone = h('div', {});
      const renderAnoms = (): void => {
        anomZone.replaceChildren(d.anomalies.length === 0 ? h('p', { class: 'section-note' }, '—')
          : dataTable<TimeAnomalyItem>({
            columns: [
              { key: 'code', labelKey: 'time.anomCode', render: (a) => catalogLabel(catalog, a.code) },
              { key: 'sev', labelKey: 'time.anomSeverity', render: (a) => severityBadge(a.severity) },
              { key: 'state', labelKey: 'time.anomState', render: (a) => anomalyStateBadge(a.state) },
              { key: 'detail', labelKey: 'time.note', render: (a) => a.detail ?? '—' },
              {
                key: 'act', labelKey: 'time.anomState',
                render: (a) => canManage ? anomalyActions(session, a, () => void load()) : h('span', {}, '—'),
              },
            ],
            rows: d.anomalies,
          }));
      };
      renderAnoms();
      blocks.push(h('div', { class: 'glass card' }, h('h3', {}, t('time.calAnomalies')), anomZone));

      // Versions : historique + comparaison (uniquement s'il y a plusieurs versions).
      if (d.versionCount > 1) {
        blocks.push(await versionsBlock(session, employeeId, date));
      }
      zone.replaceChildren(...blocks);
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }
  await load();
  return root;
}

/** Actions d'état d'une anomalie — « resolved » n'existe PAS ici : circuit E10.3. */
function anomalyActions(session: Session, a: TimeAnomalyItem, reload: () => void): HTMLElement {
  const wrap = h('span', { class: 'filters' });
  const act = (state: string, labelKey: MessageKey): HTMLButtonElement =>
    button(t(labelKey), async () => {
      try {
        await session.api.call('timeAnomalyState', { params: { id: a.id }, body: { state } });
        toast(t('time.anomStateChanged'));
        reload();
      } catch (e) {
        toast((e as ApiError).message, 'err');
      }
    }, { variant: 'ghost' });
  if (a.state === 'open') {
    wrap.appendChild(act('acknowledged', 'time.anomAcknowledge'));
    wrap.appendChild(act('dismissed', 'time.anomDismiss'));
  } else if (a.state === 'acknowledged') {
    wrap.appendChild(act('dismissed', 'time.anomDismiss'));
    wrap.appendChild(act('open', 'time.anomReopen'));
  } else if (a.state === 'dismissed') {
    wrap.appendChild(act('open', 'time.anomReopen'));
  }
  return wrap;
}

async function versionsBlock(session: Session, employeeId: string, date: string): Promise<HTMLElement> {
  const block = h('div', { class: 'glass card' }, h('h3', {}, t('time.historyTitle')));
  try {
    const hist = await session.api.call<{ versions: TimeHistoryVersion[] }>('timeResultHistory', {
      query: { employeeId, date },
    });
    block.appendChild(dataTable<TimeHistoryVersion>({
      columns: [
        { key: 'v', labelKey: 'time.calVersion', render: (v) => h('span', { class: 'mono' }, `v${v.version}`) },
        {
          key: 'cur', labelKey: 'time.calStatus',
          render: (v) => statusBadge(v.isCurrent ? 'active' : 'retired', v.isCurrent ? t('time.historyCurrent') : t('time.historySuperseded')),
        },
        { key: 'st', labelKey: 'time.calStatus', render: (v) => dayStatusBadge(v.dayStatus) },
        { key: 'worked', labelKey: 'time.calWorked', render: (v) => hoursLabel(v.workedMinutes) },
        { key: 'motive', labelKey: 'time.historyMotive', render: (v) => `${v.runIsRecalc ? '↻ ' : ''}${v.runReason}` },
        { key: 'at', labelKey: 'time.calDate', render: (v) => fmtDateTime(v.computedAt) },
        { key: 'an', labelKey: 'time.calAnomalies', render: (v) => String(v.anomalyCount) },
      ],
      rows: hist.versions,
    }));
    // Comparaison de la dernière version remplacée avec la courante.
    const last = hist.versions[hist.versions.length - 1];
    const prev = hist.versions[hist.versions.length - 2];
    if (last && prev) {
      const cmp = await session.api.call<TimeCompareOut>('timeResultCompare', {
        query: { employeeId, date, v1: prev.version, v2: last.version },
      });
      const cmpBlock = h('div', {},
        h('h3', {}, t('time.compareTitle', { a: prev.version, b: last.version })));
      cmpBlock.appendChild(cmp.fields.length === 0
        ? h('p', { class: 'section-note' }, t('time.compareIdentical'))
        : dataTable<TimeCompareOut['fields'][number]>({
          columns: [
            { key: 'f', labelKey: 'time.compareField', render: (f) => h('span', { class: 'mono' }, f.field) },
            { key: 'a', labelKey: 'time.previewCurrent', render: (f) => JSON.stringify(f.a ?? null) },
            { key: 'b', labelKey: 'time.previewNext', render: (f) => JSON.stringify(f.b ?? null) },
          ],
          rows: cmp.fields,
        }));
      block.appendChild(cmpBlock);
    }
  } catch {
    block.appendChild(h('p', { class: 'section-note' }, t('time.noResultYet')));
  }
  return block;
}

// ---------------------------------------------------------------------------
// File des anomalies
// ---------------------------------------------------------------------------

export async function timeAnomaliesPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('time.anomaliesTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.anomaliesHint')));
  const catalog = await loadCatalog(session);
  const canManage = session.hasPermission('time.anomalies_manage');

  const stateSel = selectField('time.anomState', [
    { value: 'open', label: t('time.astate.open') },
    { value: '', label: '—' },
    { value: 'acknowledged', label: t('time.astate.acknowledged') },
    { value: 'dismissed', label: t('time.astate.dismissed') },
    { value: 'resolved', label: t('time.astate.resolved') },
  ]);
  const sevSel = selectField('time.anomSeverity', [
    { value: '', label: '—' },
    { value: 'blocking', label: t('time.severity.blocking') },
    { value: 'warning', label: t('time.severity.warning') },
    { value: 'info', label: t('time.severity.info') },
  ]);
  const codeSel = selectField('time.anomCode', [{ value: '', label: '—' }].concat(
    [...catalog.values()].map((c) => ({ value: c.code, label: catalogLabel(catalog, c.code) })),
  ));
  const from = field('time.from', { type: 'date' });
  const to = field('time.to', { type: 'date' });
  const go = button(t('app.search'), null, { variant: 'primary', type: 'submit' });
  const form = h('form', { class: 'filters' }, stateSel.wrap, sevSel.wrap, codeSel.wrap, from.wrap, to.wrap, go) as HTMLFormElement;
  root.appendChild(h('div', { class: 'glass card' }, form));
  const zone = h('div', {});
  root.appendChild(zone);

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: TimeAnomalyItem[] }>('timeAnomalies', {
        query: {
          state: stateSel.select.value || undefined,
          severity: sevSel.select.value || undefined,
          code: codeSel.select.value || undefined,
          from: from.input.value || undefined, to: to.input.value || undefined,
          limit: 200,
        },
      });
      zone.replaceChildren(res.items.length === 0 ? states.empty() : dataTable<TimeAnomalyItem>({
        columns: [
          { key: 'date', labelKey: 'time.calDate', render: (a) => h('a', { href: `#/time/results/${a.employeeId}/${a.workDate}`, class: 'mono' }, a.workDate ?? '') },
          { key: 'mat', labelKey: 'emp.matricule', render: (a) => h('span', { class: 'mono' }, a.matricule ?? '') },
          { key: 'name', labelKey: 'emp.name', render: (a) => `${a.firstName ?? ''} ${a.lastName ?? ''}` },
          { key: 'code', labelKey: 'time.anomCode', render: (a) => catalogLabel(catalog, a.code) },
          { key: 'sev', labelKey: 'time.anomSeverity', render: (a) => severityBadge(a.severity) },
          { key: 'state', labelKey: 'time.anomState', render: (a) => anomalyStateBadge(a.state) },
          {
            key: 'act', labelKey: 'time.anomState',
            render: (a) => canManage ? anomalyActions(session, a, () => void load()) : h('span', {}, '—'),
          },
        ],
        rows: res.items,
      }));
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }
  form.addEventListener('submit', (ev) => { ev.preventDefault(); void load(); });
  await load();
  return root;
}

// ---------------------------------------------------------------------------
// Exécutions : liste + déclenchement + recalcul motivé avec prévisualisation
// ---------------------------------------------------------------------------

export async function timeRunsPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('time.runsTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.runsHint')));
  const canRun = session.hasPermission('time.calc_run');
  const canRecalc = session.hasPermission('time.calc_recalc');
  const zone = h('div', {});
  const previewZone = h('div', {});

  if (canRun || canRecalc) {
    const from = field('time.from', { type: 'date', required: true });
    const to = field('time.to', { type: 'date', required: true });
    const today = new Date();
    from.input.value = toIsoDate(new Date(today.getFullYear(), today.getMonth(), 1));
    to.input.value = toIsoDate(today);
    const scopeSel = selectField('time.runScope', [
      { value: 'tenant', label: t('time.runScope.tenant') },
      { value: 'employee', label: t('time.runScope.employee') },
    ]);
    const employees = await employeeOptions(session);
    const empSel = selectField('time.runScope.employee', employees ?? []);
    empSel.wrap.style.display = 'none';
    scopeSel.select.addEventListener('change', () => {
      empSel.wrap.style.display = scopeSel.select.value === 'employee' ? '' : 'none';
    });
    const reason = field('time.runReason', { required: true });
    const body = (): { periodStart: string; periodEnd: string; scopeKind: string; scopeId?: string; reason: string } => ({
      periodStart: from.input.value, periodEnd: to.input.value,
      scopeKind: scopeSel.select.value,
      ...(scopeSel.select.value === 'employee' ? { scopeId: empSel.select.value } : {}),
      reason: reason.input.value.trim(),
    });
    const actions: HTMLElement[] = [];
    const doRun = async (key: 'timeCalcRun' | 'timeCalcRecalc'): Promise<void> => {
      try {
        const res = await session.api.call<{ run: TimeCalcRun }>(key, { body: body() });
        toast(t('time.runDone', { written: res.run.resultsWritten, unchanged: res.run.resultsUnchanged }));
        previewZone.replaceChildren();
        await load();
      } catch (e) {
        toast((e as ApiError).message, 'err');
      }
    };
    if (canRun) actions.push(button(t('time.runLaunch'), () => doRun('timeCalcRun'), { variant: 'primary' }));
    if (canRecalc) {
      actions.push(button(t('time.runPreview'), async () => {
        try {
          const p = await session.api.call<TimeCalcPreviewOut>('timeCalcPreview', { body: body() });
          renderPreview(p);
        } catch (e) {
          toast((e as ApiError).message, 'err');
        }
      }, { variant: 'ghost' }));
      actions.push(button(t('time.runRecalc'), () => doRun('timeCalcRecalc'), { variant: 'ghost' }));
    }
    root.appendChild(h('div', { class: 'glass card' },
      h('div', { class: 'filters' }, from.wrap, to.wrap, scopeSel.wrap, empSel.wrap, reason.wrap),
      h('div', { class: 'filters' }, ...actions)));
    root.appendChild(previewZone);
  }
  root.appendChild(zone);

  function renderPreview(p: TimeCalcPreviewOut): void {
    const card = h('div', { class: 'glass card' },
      h('h3', {}, t('time.previewTitle')),
      h('p', { class: 'section-note' }, t('time.previewSummary', {
        evaluated: p.evaluated, wouldWrite: p.wouldWrite, unchanged: p.unchanged,
      })));
    if (p.diffs.length === 0) {
      card.appendChild(h('p', { class: 'section-note' }, t('time.previewNone')));
    } else {
      card.appendChild(dataTable<TimeCalcPreviewOut['diffs'][number]>({
        columns: [
          { key: 'd', labelKey: 'time.calDate', render: (x) => h('span', { class: 'mono' }, x.date) },
          {
            key: 'cur', labelKey: 'time.previewCurrent',
            render: (x) => x.currentStatus === null ? '—' : dayStatusBadge(x.currentStatus),
          },
          { key: 'next', labelKey: 'time.previewNext', render: (x) => dayStatusBadge(x.nextStatus) },
          { key: 'f', labelKey: 'time.previewFields', render: (x) => h('span', { class: 'mono' }, x.changedFields.join(', ')) },
        ],
        rows: p.diffs,
      }));
    }
    previewZone.replaceChildren(card);
  }

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: TimeCalcRun[] }>('timeCalcRuns', { query: { limit: 50 } });
      zone.replaceChildren(res.items.length === 0 ? states.empty() : dataTable<TimeCalcRun>({
        columns: [
          { key: 'period', labelKey: 'time.runPeriod', render: (r) => h('span', { class: 'mono' }, `${r.periodStart} → ${r.periodEnd}`) },
          { key: 'scope', labelKey: 'time.runScope', render: (r) => t((`time.runScope.${r.scopeKind}`) as MessageKey) },
          { key: 'reason', labelKey: 'time.historyMotive', render: (r) => `${r.isRecalc ? '↻ ' : ''}${r.reason}` },
          {
            key: 'status', labelKey: 'time.runStatus',
            render: (r) => statusBadge(r.status === 'completed' ? 'active' : r.status.startsWith('completed') ? 'draft' : 'retired',
              t((`time.runStatus.${r.status}`) as MessageKey)),
          },
          { key: 'n', labelKey: 'time.runCounters', render: (r) => `${r.employeesCount} × ${r.daysCount}` },
          { key: 'w', labelKey: 'time.runWritten', render: (r) => String(r.resultsWritten) },
          { key: 'u', labelKey: 'time.runUnchanged', render: (r) => String(r.resultsUnchanged) },
          { key: 'e', labelKey: 'time.runErrors', render: (r) => String(r.resultsError) },
          { key: 'a', labelKey: 'time.runAnomalies', render: (r) => String(r.anomaliesCount) },
          { key: 'ms', labelKey: 'time.runDuration', render: (r) => r.durationMs === null ? '—' : `${r.durationMs} ms` },
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
