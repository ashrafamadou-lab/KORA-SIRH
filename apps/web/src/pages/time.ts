/**
 * Temps & pointage (E10.1 via PWA) — écrans : modèles d'horaires (versions + cycle,
 * nuits sans ambiguïté), affectations (individuelle/collective, clôture), import
 * CSV/Excel (préversion sans écriture → application), lots + rapport par ligne,
 * registre brut (portée réelle), file des non-appariés (correspondance +
 * renormalisation), dispositifs, mes pointages, saisie manuelle.
 *
 * RÈGLES : cacher un menu n'est JAMAIS la sécurité (le serveur tranche) ; AUCUNE
 * donnée de pointage n'est mise en cache hors ligne (API network-only, aucun
 * stockage local) ; tout texte passe par t().
 */
import { h } from '../core/dom.ts';
import { t, getLocale, type MessageKey } from '../core/i18n.ts';
import { toIsoDate } from '../core/format.ts';
import type { Session } from '../core/session.ts';
import type {
  ApiError, EmployeeListItem, OrgItem, OrgUnitItem,
  TimeAssignmentRow, TimeBatchDetail, TimeBatchRow, TimeDeviceRow, TimeEmployeeSchedule,
  TimeImportResult, TimeMappingRow, TimeModelDetail, TimeModelRow, TimeMyEventRow,
  TimeRawPunchRow, TimeScheduleDay, TimeUnmatchedRow,
} from '../core/api.ts';
import {
  button, confirmModal, dataTable, field, kv, pageTitle, selectField,
  stateForError, states, statusBadge, toast,
} from '../ui/kit.ts';

const MATCH_KEY: Record<string, MessageKey> = {
  matched: 'time.match.matched',
  unmatched_employee: 'time.match.unmatched_employee',
  inactive_employee: 'time.match.inactive_employee',
  not_yet_hired: 'time.match.not_yet_hired',
  no_assignment: 'time.match.no_assignment',
  invalid_datetime: 'time.match.invalid_datetime',
  ambiguous_datetime: 'time.match.ambiguous_datetime',
};
const EVENT_KEY: Record<string, MessageKey> = {
  in: 'time.event.in', out: 'time.event.out',
  break_start: 'time.event.break_start', break_end: 'time.event.break_end', unknown: 'time.event.unknown',
};
const BATCH_STATUS_KEY: Record<string, MessageKey> = {
  applied: 'time.status.applied', partial: 'time.status.partial', rejected: 'time.status.rejected',
};

function matchBadge(status: string | null): HTMLElement {
  if (status === null) return h('span', {}, '—');
  const key = MATCH_KEY[status];
  return statusBadge(status === 'matched' ? 'active' : 'draft', key ? t(key) : status);
}
function eventLabel(type: string | null): string {
  if (type === null) return '—';
  const key = EVENT_KEY[type];
  return key ? t(key) : type;
}
function localizedLabel(item: { labelFr: string; labelEn: string }): string {
  return getLocale() === 'en' ? item.labelEn : item.labelFr;
}
const pad2 = (n: number) => String(n).padStart(2, '0');
/** 1320 → « 22:00 », 1800 → « 06:00 (+1 j) » : la traversée de minuit est un FAIT. */
function minuteLabel(m: number): string {
  const base = m >= 1440 ? m - 1440 : m;
  const s = `${pad2(Math.floor(base / 60))}:${pad2(base % 60)}`;
  return m >= 1440 ? `${s} ${t('time.nextDay')}` : s;
}
function dayShiftLabel(d: TimeScheduleDay): string {
  if (d.isRest) return t('time.rest');
  let s = `${minuteLabel(d.startMinute!)} → ${minuteLabel(d.endMinute!)}`;
  if (d.breakStartMinute !== null && d.breakEndMinute !== null) {
    s += ` · ${t('time.break')} ${minuteLabel(d.breakStartMinute)}–${minuteLabel(d.breakEndMinute)}`;
  }
  return s;
}
/** « HH:MM » → minutes ; fin < début ⇒ lendemain (end += 1440). */
function parseShift(start: string, end: string): { startMinute: number; endMinute: number } | null {
  const re = /^(\d{1,2}):(\d{2})$/;
  const ms = re.exec(start.trim());
  const me = re.exec(end.trim());
  if (!ms || !me) return null;
  const a = Number(ms[1]) * 60 + Number(ms[2]);
  let b = Number(me[1]) * 60 + Number(me[2]);
  if (a > 1439 || b > 1439) return null;
  if (b <= a) b += 1440;
  return { startMinute: a, endMinute: b };
}

/** Sélecteur de salarié GUARDÉ : sans employees.view, message honnête (pas de simulacre). */
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
// Modèles d'horaires
// ---------------------------------------------------------------------------

export async function timeModelsPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  const canManage = session.hasPermission('time.schedules_manage');
  root.appendChild(pageTitle(t('time.modelsTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.modelsHint')));
  const zone = h('div', {});
  root.appendChild(zone);

  if (canManage) {
    const code = field('time.code', { required: true });
    const labelFr = field('time.label', { required: true });
    const labelEn = field('time.label', { required: true });
    labelEn.input.placeholder = 'English';
    const kind = selectField('time.kind', [
      { value: 'fixed', label: t('time.kind.fixed') },
      { value: 'rotation', label: t('time.kind.rotation') },
    ]);
    const submit = button(t('time.newModel'), null, { variant: 'primary', type: 'submit' });
    const form = h('form', { class: 'filters' }, code.wrap, labelFr.wrap, labelEn.wrap, kind.wrap, submit) as HTMLFormElement;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      void (async () => {
        try {
          await session.api.call('timeModelCreate', {
            body: {
              code: code.input.value.trim().toUpperCase(), labelFr: labelFr.input.value.trim(),
              labelEn: labelEn.input.value.trim(), kind: kind.select.value,
            },
          });
          toast(t('app.save'));
          await load();
        } catch (e) {
          toast((e as ApiError).message, 'err');
        } finally {
          submit.disabled = false;
        }
      })();
    });
    root.insertBefore(h('div', { class: 'glass card' }, form), zone);
  }

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: TimeModelRow[] }>('timeModels');
      zone.replaceChildren(res.items.length === 0 ? states.empty() : dataTable<TimeModelRow>({
        columns: [
          { key: 'code', labelKey: 'time.code', render: (r) => h('a', { href: `#/time/schedules/${r.id}`, class: 'mono' }, r.code) },
          { key: 'label', labelKey: 'time.label', render: (r) => localizedLabel(r) },
          { key: 'kind', labelKey: 'time.kind', render: (r) => t(r.kind === 'fixed' ? 'time.kind.fixed' : 'time.kind.rotation') },
          { key: 'versions', labelKey: 'time.versions', render: (r) => String(r.versionCount) },
          { key: 'assigned', labelKey: 'time.assignedToday', render: (r) => String(r.assignedToday) },
          { key: 'status', labelKey: 'time.status', render: (r) => statusBadge(r.status === 'active' ? 'active' : 'archived', r.status) },
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

export async function timeModelDetailPage(session: Session, id: string): Promise<HTMLElement> {
  const root = h('div', {});
  const canManage = session.hasPermission('time.schedules_manage');
  const zone = h('div', {});
  root.appendChild(zone);

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ model: TimeModelDetail }>('timeModel', { params: { id } });
      const m = res.model;
      const parts: HTMLElement[] = [
        pageTitle(`${m.code} — ${localizedLabel(m)}`),
        h('p', { class: 'section-note' }, `${t('time.kind')} : ${t(m.kind === 'fixed' ? 'time.kind.fixed' : 'time.kind.rotation')}`),
      ];
      for (const v of [...m.versions].reverse()) {
        const grid = dataTable<TimeScheduleDay>({
          columns: [
            { key: 'day', labelKey: 'time.dayIndex', render: (d) => h('span', { class: 'mono' }, String(d.dayIndex + 1)) },
            { key: 'shift', labelKey: 'time.shift', render: (d) => dayShiftLabel(d) },
          ],
          rows: [...v.days].sort((a, b) => a.dayIndex - b.dayIndex),
        });
        parts.push(h('div', { class: 'glass card' },
          h('h2', {}, `${t('time.versions')} ${v.version} — ${t('time.effectiveFrom')} ${v.effectiveFrom} (${t('time.cycleDays')} : ${v.cycleDays})`),
          v.notes ? h('p', { class: 'section-note' }, v.notes) : h('span', {}),
          grid,
        ));
      }
      if (canManage && m.status === 'active') parts.push(newVersionCard(m));
      zone.replaceChildren(...parts);
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }

  function newVersionCard(m: TimeModelDetail): HTMLElement {
    const from = field('time.effectiveFrom', { type: 'date', required: true });
    from.input.value = toIsoDate(new Date());
    const cycle = field('time.cycleDays', { type: 'number', required: true });
    cycle.input.min = '1';
    cycle.input.max = '42';
    cycle.input.value = String(m.versions[m.versions.length - 1]?.cycleDays ?? 7);
    const daysZone = h('div', {});
    const rows: Array<{ rest: HTMLInputElement; start: HTMLInputElement; end: HTMLInputElement }> = [];

    function renderDays(): void {
      const n = Math.min(Math.max(Number(cycle.input.value) || 1, 1), 42);
      rows.length = 0;
      const list = h('div', { class: 'daylist' });
      for (let i = 0; i < n; i += 1) {
        const rest = h('input', { type: 'checkbox', 'aria-label': `${t('time.rest')} ${i + 1}` }) as HTMLInputElement;
        const start = h('input', { type: 'time', value: '08:00', 'aria-label': `${t('time.start')} ${i + 1}` }) as HTMLInputElement;
        const end = h('input', { type: 'time', value: '17:00', 'aria-label': `${t('time.end')} ${i + 1}` }) as HTMLInputElement;
        rest.addEventListener('change', () => {
          start.disabled = rest.checked;
          end.disabled = rest.checked;
        });
        rows.push({ rest, start, end });
        list.appendChild(h('div', { class: 'dayrow' },
          h('span', { class: 'mono' }, `${t('time.dayIndex')} ${i + 1}`),
          h('label', { class: 'inline' }, rest, ` ${t('time.rest')}`),
          start, h('span', {}, '→'), end,
        ));
      }
      daysZone.replaceChildren(list);
    }
    cycle.input.addEventListener('change', renderDays);
    renderDays();

    const submit = button(t('time.newVersion'), null, { variant: 'primary', type: 'submit' });
    const err = h('p', { class: 'error', role: 'alert' });
    const form = h('form', {},
      h('div', { class: 'filters' }, from.wrap, cycle.wrap),
      h('p', { class: 'section-note' }, t('time.nightHint')),
      daysZone, err, submit) as HTMLFormElement;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (submit.disabled) return;
      err.textContent = '';
      const days = [];
      for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i]!;
        if (r.rest.checked) {
          days.push({ dayIndex: i, isRest: true });
          continue;
        }
        const shift = parseShift(r.start.value, r.end.value);
        if (!shift) {
          err.textContent = `${t('form.invalid')} — ${t('time.dayIndex')} ${i + 1}`;
          return;
        }
        days.push({ dayIndex: i, isRest: false, ...shift });
      }
      submit.disabled = true;
      void (async () => {
        try {
          await session.api.call('timeVersionCreate', {
            params: { id }, body: { effectiveFrom: from.input.value, cycleDays: rows.length, days },
          });
          toast(t('app.save'));
          await load();
        } catch (e) {
          err.textContent = (e as ApiError).message;
        } finally {
          submit.disabled = false;
        }
      })();
    });
    return h('div', { class: 'glass card' }, h('h2', {}, t('time.newVersion')),
      h('p', { class: 'section-note' }, t('time.versionPastLocked')), form);
  }

  await load();
  return root;
}

// ---------------------------------------------------------------------------
// Affectations
// ---------------------------------------------------------------------------

export async function timeAssignmentsPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  const canAssign = session.hasPermission('time.schedules_assign');
  root.appendChild(pageTitle(t('time.assignTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.assignHint')));

  const models = await session.api.call<{ items: TimeModelRow[] }>('timeModels').catch(() => ({ items: [] as TimeModelRow[] }));
  const modelOpts = models.items.filter((m) => m.status === 'active')
    .map((m) => ({ value: m.id, label: `${m.code} — ${localizedLabel(m)}` }));

  const listZone = h('div', {});

  if (canAssign) {
    const employees = await employeeOptions(session);
    const empSel = employees ? selectField('time.employee', employees) : null;
    const modelSel = selectField('time.model', modelOpts);
    const anchor = field('time.anchorDate', { type: 'date', required: true });
    anchor.input.value = toIsoDate(new Date());
    const from = field('time.effectiveFrom', { type: 'date', required: true });
    from.input.value = toIsoDate(new Date());
    const closePrev = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const submit = button(t('time.assignEmployee'), null, { variant: 'primary', type: 'submit' });
    const err = h('p', { class: 'error', role: 'alert' });
    const form = h('form', {},
      h('div', { class: 'filters' },
        empSel ? empSel.wrap : h('p', { class: 'section-note' }, t('time.needEmployeesView')),
        modelSel.wrap, anchor.wrap, from.wrap),
      h('label', { class: 'inline' }, closePrev, ` ${t('time.closePrevious')}`),
      err, submit) as HTMLFormElement;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (submit.disabled || !empSel) return;
      err.textContent = '';
      submit.disabled = true;
      void (async () => {
        try {
          await session.api.call('timeAssign', {
            body: {
              employeeId: empSel.select.value, modelId: modelSel.select.value,
              anchorDate: anchor.input.value, effectiveFrom: from.input.value,
              closePrevious: closePrev.checked,
            },
          });
          toast(t('app.save'));
          await loadList();
        } catch (e) {
          err.textContent = (e as ApiError).message;
        } finally {
          submit.disabled = false;
        }
      })();
    });
    root.appendChild(h('div', { class: 'glass card' }, h('h2', {}, t('time.assignEmployee')), form));

    // Collective : par unité (org.view requis pour lister les unités).
    if (session.hasPermission('org.view')) {
      const units = await session.api.call<OrgUnitItem[]>('orgUnits', { query: { limit: 200 } }).catch(() => [] as OrgUnitItem[]);
      const unitSel = selectField('time.unit', units.map((u) => ({ value: u.id, label: `${u.code} — ${localizedLabel(u)}` })));
      const modelSel2 = selectField('time.model', modelOpts);
      const anchor2 = field('time.anchorDate', { type: 'date', required: true });
      anchor2.input.value = toIsoDate(new Date());
      const from2 = field('time.effectiveFrom', { type: 'date', required: true });
      from2.input.value = toIsoDate(new Date());
      const closePrev2 = h('input', { type: 'checkbox' }) as HTMLInputElement;
      const submit2 = button(t('time.assignUnit'), null, { variant: 'primary', type: 'submit' });
      const out2 = h('p', { class: 'section-note', role: 'status' });
      const form2 = h('form', {},
        h('div', { class: 'filters' }, unitSel.wrap, modelSel2.wrap, anchor2.wrap, from2.wrap),
        h('label', { class: 'inline' }, closePrev2, ` ${t('time.closePrevious')}`),
        out2, submit2) as HTMLFormElement;
      form2.addEventListener('submit', (ev) => {
        ev.preventDefault();
        if (submit2.disabled) return;
        submit2.disabled = true;
        void (async () => {
          try {
            const res = await session.api.call<{ assigned: number; skipped: number }>('timeAssignByUnit', {
              body: {
                unitId: unitSel.select.value, modelId: modelSel2.select.value,
                anchorDate: anchor2.input.value, effectiveFrom: from2.input.value,
                closePrevious: closePrev2.checked,
              },
            });
            out2.textContent = `${t('time.assigned')} : ${res.assigned} · ${t('time.skipped')} : ${res.skipped}`;
            await loadList();
          } catch (e) {
            out2.textContent = (e as ApiError).message;
          } finally {
            submit2.disabled = false;
          }
        })();
      });
      root.appendChild(h('div', { class: 'glass card' }, h('h2', {}, t('time.assignUnit')), form2));
    } else {
      root.appendChild(h('p', { class: 'section-note' }, t('time.needOrgView')));
    }
  }

  // Horaire applicable à une date (consultation).
  const schedZone = h('div', {});
  {
    const employees2 = await employeeOptions(session);
    if (employees2 && employees2.length > 0) {
      const empSel2 = selectField('time.employee', employees2);
      const dateIn = field('time.scheduleAtDate', { type: 'date', required: true });
      dateIn.input.value = toIsoDate(new Date());
      const show = button(t('app.search'), () => void showSchedule(), { variant: 'primary' });
      async function showSchedule(): Promise<void> {
        schedZone.replaceChildren(states.loading());
        try {
          const res = await session.api.call<TimeEmployeeSchedule>('timeEmployeeSchedule', {
            params: { id: empSel2.select.value }, query: { date: dateIn.input.value },
          });
          if (!res.assigned) {
            schedZone.replaceChildren(h('p', { class: 'section-note' }, t('time.noSchedule')));
            return;
          }
          const entries: Array<[string, string | HTMLElement]> = [
            [t('time.model'), `${res.modelCode} (v${res.applicableVersion ?? '—'})`],
            [t('time.dayIndex'), `${(res.dayIndex ?? 0) + 1} / ${res.cycleDays}`],
            [t('time.shift'), res.day ? dayShiftLabel(res.day) : '—'],
          ];
          if (res.exception) entries.push([t('time.exception'), `${res.exception.kind} — ${getLocale() === 'en' ? res.exception.labelEn : res.exception.labelFr}`]);
          for (const hd of res.holidays ?? []) entries.push([t('time.holiday'), getLocale() === 'en' ? hd.labelEn : hd.labelFr]);
          schedZone.replaceChildren(kv(entries));
        } catch (e) {
          schedZone.replaceChildren(stateForError(e as ApiError));
        }
      }
      root.appendChild(h('div', { class: 'glass card' },
        h('h2', {}, t('time.scheduleAt')),
        h('div', { class: 'filters' }, empSel2.wrap, dateIn.wrap, show),
        schedZone));
    }
  }

  root.appendChild(listZone);
  async function loadList(): Promise<void> {
    listZone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: TimeAssignmentRow[] }>('timeAssignments', { query: { limit: 200 } });
      listZone.replaceChildren(res.items.length === 0 ? states.empty() : dataTable<TimeAssignmentRow>({
        columns: [
          { key: 'emp', labelKey: 'time.employee', render: (r) => h('span', {}, h('span', { class: 'mono' }, r.matricule), ` ${r.firstName} ${r.lastName}`) },
          { key: 'model', labelKey: 'time.model', render: (r) => `${r.modelCode} — ${getLocale() === 'en' ? r.modelLabelEn : r.modelLabelFr}` },
          { key: 'anchor', labelKey: 'time.anchorDate', render: (r) => r.anchorDate },
          { key: 'from', labelKey: 'time.effectiveFrom', render: (r) => r.effectiveFrom },
          {
            key: 'to', labelKey: 'time.effectiveTo', render: (r) => {
              if (r.effectiveTo) return h('span', {}, r.effectiveTo);
              if (!canAssign) return h('span', {}, '—');
              return button(t('time.close'), async () => {
                if (!(await confirmModal(`${t('time.close')} — ${r.matricule} ?`, { danger: true }))) return;
                try {
                  await session.api.call('timeAssignmentClose', {
                    params: { id: r.id }, body: { effectiveTo: toIsoDate(new Date()) },
                  });
                  toast(t('app.save'));
                  await loadList();
                } catch (e) {
                  toast((e as ApiError).message, 'err');
                }
              }, { variant: 'danger' });
            },
          },
        ],
        rows: res.items,
      }));
    } catch (e) {
      listZone.replaceChildren(stateForError(e as ApiError, () => void loadList()));
    }
  }
  await loadList();
  return root;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export async function timeImportPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('time.importTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.importHint')));

  const source = selectField('time.importSource', [
    { value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'Excel (.xlsx)' },
  ]);
  const fileIn = h('input', { type: 'file', accept: '.csv,.xlsx', 'aria-label': t('time.importFile') }) as HTMLInputElement;
  const pasteArea = h('textarea', { rows: '6', class: 'mono', 'aria-label': t('time.importPaste'), placeholder: 'matricule;dateheure;sens' }) as HTMLTextAreaElement;

  const devices = await session.api.call<{ items: TimeDeviceRow[] }>('timeDevices').catch(() => ({ items: [] as TimeDeviceRow[] }));
  const deviceSel = selectField('time.importDevice', [{ value: '', label: '—' },
    ...devices.items.filter((d) => d.status === 'active').map((d) => ({ value: d.id, label: `${d.code} — ${d.label}` }))]);
  let siteOpts: Array<{ value: string; label: string }> = [{ value: '', label: '—' }];
  if (session.hasPermission('org.view')) {
    const sites = await session.api.call<OrgItem[]>('orgSites', { query: { limit: 200 } }).catch(() => [] as OrgItem[]);
    siteOpts = [{ value: '', label: '—' }, ...sites.map((s) => ({ value: s.id, label: `${s.code} — ${localizedLabel(s)}` }))];
  }
  const siteSel = selectField('time.importSite', siteOpts);
  const partial = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const keepFile = h('input', { type: 'checkbox', checked: '' }) as HTMLInputElement;

  const reportZone = h('div', {});
  // Câblage MANUEL (pas guardedRun) : run() gère lui-même l'anti double-envoi ET
  // l'état de l'autre bouton (l'application ne s'ouvre qu'après une préversion saine).
  const previewBtn = button(t('time.preview'), null, { variant: 'primary' });
  const applyBtn = button(t('time.apply'), null, { variant: 'primary' });
  previewBtn.addEventListener('click', () => void run('preview'));
  applyBtn.addEventListener('click', () => void run('apply'));
  applyBtn.disabled = true;

  let payload: { contentText?: string; contentBase64?: string; filename?: string } | null = null;

  async function readSelectedFile(): Promise<void> {
    const f = fileIn.files?.[0];
    if (!f) {
      const text = pasteArea.value.trim();
      payload = text.length > 0 ? { contentText: text, filename: 'presse-papiers.csv' } : null;
      if (payload) source.select.value = 'csv';
      return;
    }
    if (f.name.toLowerCase().endsWith('.xlsx')) {
      source.select.value = 'xlsx';
      const buf = await f.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
      payload = { contentBase64: btoa(bin), filename: f.name };
    } else {
      source.select.value = 'csv';
      payload = { contentText: await f.text(), filename: f.name };
    }
  }

  async function run(mode: 'preview' | 'apply'): Promise<void> {
    const btn = mode === 'preview' ? previewBtn : applyBtn;
    if (btn.disabled) return;
    btn.disabled = true;
    reportZone.replaceChildren(states.loading());
    try {
      await readSelectedFile();
      if (!payload) {
        reportZone.replaceChildren(h('p', { class: 'error', role: 'alert' }, t('time.importNone')));
        return;
      }
      const res = await session.api.call<TimeImportResult>('timeImport', {
        body: {
          source: source.select.value, mode, ...payload,
          ...(deviceSel.select.value ? { defaultDeviceId: deviceSel.select.value } : {}),
          ...(siteSel.select.value ? { defaultSiteId: siteSel.select.value } : {}),
          acceptOnlyValid: partial.checked,
          keepFile: keepFile.checked,
        },
      });
      renderReport(res, mode);
      applyBtn.disabled = !(mode === 'preview' && (res.wouldApply === true || partial.checked));
    } catch (e) {
      reportZone.replaceChildren(stateForError(e as ApiError));
    } finally {
      btn.disabled = btn === applyBtn ? applyBtn.disabled : false;
      previewBtn.disabled = false;
    }
  }

  function renderReport(res: TimeImportResult, mode: 'preview' | 'apply'): void {
    const parts: HTMLElement[] = [];
    parts.push(kv([
      [t('time.received'), String(res.counts.received)],
      [t('time.accepted'), String(res.counts.accepted)],
      [t('time.duplicated'), String(res.counts.duplicated)],
      [t('time.rejectedCount'), String(res.counts.rejected)],
      [t('time.unmatchedCount'), String(res.counts.unmatched)],
    ]));
    if (mode === 'preview') {
      parts.push(h('p', { class: res.wouldApply ? 'section-note' : 'error', role: 'status' },
        res.wouldApply ? t('time.importWouldApply') : t('time.importWouldReject')));
      if (res.effective) {
        parts.push(h('p', { class: 'section-note' },
          `${t('time.columns')} : ${Object.entries(res.effective).map(([c, r]) => `${c}→${r}`).join(' · ')}`));
      }
    } else {
      const key = BATCH_STATUS_KEY[res.kind];
      parts.push(h('p', { class: 'section-note', role: 'status' },
        key ? t(key) : res.kind,
        ' — ',
        h('a', { href: `#/time/batches/${res.batchId}` }, t('time.batchTitle'))));
    }
    if (res.errors.length > 0) {
      parts.push(dataTable<{ line: number; error: string }>({
        columns: [
          { key: 'line', labelKey: 'time.line', render: (r) => h('span', { class: 'mono' }, String(r.line)) },
          { key: 'error', labelKey: 'time.error', render: (r) => r.error },
        ],
        rows: res.errors,
      }));
    }
    reportZone.replaceChildren(...parts);
  }

  root.appendChild(h('div', { class: 'glass card' },
    h('div', { class: 'filters' }, source.wrap,
      h('div', { class: 'field' }, h('label', {}, t('time.importFile')), fileIn),
      deviceSel.wrap, siteSel.wrap),
    h('div', { class: 'field' }, h('label', {}, t('time.importPaste')), pasteArea),
    h('label', { class: 'inline' }, partial, ` ${t('time.importPartial')}`),
    h('label', { class: 'inline' }, keepFile, ` ${t('time.importKeepFile')}`),
    h('div', { class: 'filters' }, previewBtn, applyBtn),
  ));
  root.appendChild(reportZone);

  // Saisie manuelle (source à part entière, honnêtement séparée de l'import fichier).
  const employees = await employeeOptions(session);
  if (employees && employees.length > 0) {
    const empSel = selectField('time.employee', employees);
    const dt = field('time.manualDateTime', { required: true });
    dt.input.placeholder = 'AAAA-MM-JJ HH:MM';
    const typeSel = selectField('time.eventType', [
      { value: 'E', label: t('time.event.in') }, { value: 'S', label: t('time.event.out') },
    ]);
    const manualSite = selectField('time.site', siteOpts);
    const submit = button(t('time.manualSubmit'), null, { variant: 'primary', type: 'submit' });
    const out = h('p', { class: 'section-note', role: 'status' });
    const form = h('form', { class: 'filters' }, empSel.wrap, dt.wrap, typeSel.wrap, manualSite.wrap, submit) as HTMLFormElement;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      void (async () => {
        try {
          const res = await session.api.call<{ matchStatus: string }>('timeManualPunch', {
            body: {
              employeeId: empSel.select.value, dateTime: dt.input.value.trim(), eventType: typeSel.select.value,
              ...(manualSite.select.value ? { siteId: manualSite.select.value } : {}),
            },
          });
          const mk = MATCH_KEY[res.matchStatus];
          out.textContent = t('time.manualDone', { status: mk ? t(mk) : res.matchStatus });
        } catch (e) {
          out.textContent = (e as ApiError).message;
        } finally {
          submit.disabled = false;
        }
      })();
    });
    root.appendChild(h('div', { class: 'glass card' },
      h('h2', {}, t('time.manualTitle')),
      h('p', { class: 'section-note' }, t('time.manualHint')),
      form, out));
  }
  return root;
}

// ---------------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------------

export async function timeBatchesPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('time.batchesTitle')));
  const zone = h('div', {});
  root.appendChild(zone);
  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: TimeBatchRow[] }>('timeBatches', { query: { limit: 100 } });
      zone.replaceChildren(res.items.length === 0 ? states.empty() : dataTable<TimeBatchRow>({
        columns: [
          { key: 'created', labelKey: 'audit.when', render: (r) => h('a', { href: `#/time/batches/${r.id}` }, new Date(r.createdAt).toLocaleString(getLocale())) },
          { key: 'source', labelKey: 'time.source', render: (r) => h('span', { class: 'mono' }, r.source) },
          { key: 'file', labelKey: 'time.file', render: (r) => r.filename ?? '—' },
          { key: 'status', labelKey: 'time.status', render: (r) => statusBadge(r.status === 'applied' ? 'active' : r.status === 'partial' ? 'draft' : 'archived', t(BATCH_STATUS_KEY[r.status]!)) },
          { key: 'recv', labelKey: 'time.received', render: (r) => String(r.linesReceived) },
          { key: 'acc', labelKey: 'time.accepted', render: (r) => String(r.linesAccepted) },
          { key: 'dup', labelKey: 'time.duplicated', render: (r) => String(r.linesDuplicated) },
          { key: 'rej', labelKey: 'time.rejectedCount', render: (r) => String(r.linesRejected) },
          { key: 'unm', labelKey: 'time.unmatchedCount', render: (r) => String(r.linesUnmatched) },
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

export async function timeBatchDetailPage(session: Session, id: string): Promise<HTMLElement> {
  const root = h('div', {});
  const zone = h('div', {});
  root.appendChild(zone);
  zone.appendChild(states.loading());
  try {
    const res = await session.api.call<{ batch: TimeBatchDetail }>('timeBatch', { params: { id } });
    const b = res.batch;
    const parts: HTMLElement[] = [pageTitle(`${t('time.batchTitle')} — ${b.filename ?? b.source}`)];
    parts.push(kv([
      [t('time.status'), t(BATCH_STATUS_KEY[b.status]!)],
      [t('time.source'), b.source],
      [t('time.received'), String(b.linesReceived)],
      [t('time.accepted'), String(b.linesAccepted)],
      [t('time.duplicated'), String(b.linesDuplicated)],
      [t('time.rejectedCount'), String(b.linesRejected)],
      [t('time.unmatchedCount'), String(b.linesUnmatched)],
    ]));
    const actions: HTMLElement[] = [];
    if (session.hasPermission('time.punches_import')) {
      if (b.fileKept) {
        actions.push(button(t('time.downloadFile'), async () => {
          try {
            const f = await session.api.call<{ filename: string | null; contentBase64: string }>('timeBatchFile', { params: { id } });
            const bytes = Uint8Array.from(atob(f.contentBase64), (c) => c.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([bytes]));
            const a = h('a', { href: url, download: f.filename ?? 'lot.bin' }) as HTMLAnchorElement;
            a.click();
            URL.revokeObjectURL(url);
          } catch (e) {
            toast((e as ApiError).message, 'err');
          }
        }));
      } else {
        actions.push(h('p', { class: 'section-note' }, t('time.fileNotKept')));
      }
      if (b.linesUnmatched > 0) {
        actions.push(button(t('time.renormalize'), async () => {
          try {
            const r = await session.api.call<{ processed: number; matched: number }>('timeRenormalize', { body: { batchId: id } });
            toast(t('time.renormalized', { matched: String(r.matched), processed: String(r.processed) }));
          } catch (e) {
            toast((e as ApiError).message, 'err');
          }
        }));
      }
    }
    if (actions.length > 0) parts.push(h('div', { class: 'filters' }, ...actions));
    if (b.errorReport.length > 0) {
      parts.push(dataTable<{ line: number; error: string }>({
        columns: [
          { key: 'line', labelKey: 'time.line', render: (r) => h('span', { class: 'mono' }, String(r.line)) },
          { key: 'error', labelKey: 'time.error', render: (r) => r.error },
        ],
        rows: b.errorReport,
      }));
    }
    zone.replaceChildren(...parts);
  } catch (e) {
    zone.replaceChildren(stateForError(e as ApiError));
  }
  return root;
}

// ---------------------------------------------------------------------------
// Registre brut / mes pointages / non appariés / dispositifs
// ---------------------------------------------------------------------------

export async function timePunchesPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('time.punchesTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.punchesHint')));
  const from = field('time.from', { type: 'date' });
  const to = field('time.to', { type: 'date' });
  const zone = h('div', {});
  root.appendChild(h('div', { class: 'filters' }, from.wrap, to.wrap,
    button(t('app.search'), () => void load(), { variant: 'primary' })));
  root.appendChild(zone);
  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: TimeRawPunchRow[] }>('timeRawPunches', {
        query: {
          limit: 200,
          ...(from.input.value ? { from: from.input.value } : {}),
          ...(to.input.value ? { to: to.input.value } : {}),
        },
      });
      zone.replaceChildren(res.items.length === 0 ? states.empty() : dataTable<TimeRawPunchRow>({
        columns: [
          { key: 'emp', labelKey: 'time.employee', render: (r) => r.matricule ? h('span', {}, h('span', { class: 'mono' }, r.matricule), ` ${r.firstName ?? ''} ${r.lastName ?? ''}`) : h('span', { class: 'mono' }, r.externalEmployeeId) },
          { key: 'src', labelKey: 'time.sourceDateTime', render: (r) => h('span', { class: 'mono' }, r.sourceDateTimeRaw) },
          { key: 'tz', labelKey: 'time.timezone', render: (r) => r.tz ?? '—' },
          { key: 'occ', labelKey: 'time.occurredAt', render: (r) => r.occurredAt ? new Date(r.occurredAt).toISOString().slice(0, 16).replace('T', ' ') : '—' },
          { key: 'type', labelKey: 'time.eventType', render: (r) => eventLabel(r.eventType) },
          { key: 'match', labelKey: 'time.status', render: (r) => matchBadge(r.matchStatus) },
          { key: 'dev', labelKey: 'time.device', render: (r) => r.deviceCode ?? r.deviceRef ?? '—' },
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

export async function timeMinePage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('time.mineTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.mineHint')));
  const zone = h('div', {});
  root.appendChild(zone);
  zone.appendChild(states.loading());
  try {
    const res = await session.api.call<{ linked: boolean; items: TimeMyEventRow[] }>('timeMyPunches', { query: { limit: 100 } });
    if (!res.linked) {
      zone.replaceChildren(h('div', { class: 'glass card' }, h('p', {}, t('time.mineNotLinked'))));
      return root;
    }
    zone.replaceChildren(res.items.length === 0 ? states.empty() : dataTable<TimeMyEventRow>({
      columns: [
        { key: 'date', labelKey: 'time.scheduleAtDate', render: (r) => h('span', { class: 'mono' }, `${r.localDate ?? '—'} ${r.localTime ?? ''}`) },
        { key: 'tz', labelKey: 'time.timezone', render: (r) => r.tz },
        { key: 'type', labelKey: 'time.eventType', render: (r) => eventLabel(r.eventType) },
        { key: 'match', labelKey: 'time.status', render: (r) => matchBadge(r.matchStatus) },
        { key: 'site', labelKey: 'time.site', render: (r) => r.siteCode ?? '—' },
      ],
      rows: res.items,
    }));
  } catch (e) {
    zone.replaceChildren(stateForError(e as ApiError));
  }
  return root;
}

export async function timeUnmatchedPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('time.unmatchedTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.unmatchedHint')));
  const zone = h('div', {});
  const canMap = session.hasPermission('time.devices_manage');
  const canRenorm = session.hasPermission('time.punches_import');
  const employees = canMap ? await employeeOptions(session) : null;

  if (canRenorm) {
    root.appendChild(h('div', { class: 'filters' }, button(t('time.renormalize'), async () => {
      try {
        const r = await session.api.call<{ processed: number; matched: number }>('timeRenormalize', { body: {} });
        toast(t('time.renormalized', { matched: String(r.matched), processed: String(r.processed) }));
        await load();
      } catch (e) {
        toast((e as ApiError).message, 'err');
      }
    }, { variant: 'primary' })));
  }
  root.appendChild(zone);

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: TimeUnmatchedRow[] }>('timeUnmatched', { query: { limit: 200 } });
      zone.replaceChildren(res.items.length === 0 ? states.empty() : dataTable<TimeUnmatchedRow>({
        columns: [
          { key: 'ext', labelKey: 'time.externalId', render: (r) => h('span', { class: 'mono' }, r.externalEmployeeId) },
          { key: 'src', labelKey: 'time.sourceDateTime', render: (r) => h('span', { class: 'mono' }, r.sourceDateTimeRaw) },
          { key: 'match', labelKey: 'time.status', render: (r) => matchBadge(r.matchStatus) },
          { key: 'note', labelKey: 'time.note', render: (r) => r.note ?? '—' },
          {
            key: 'map', labelKey: 'time.mapTo', render: (r) => {
              if (!canMap || !employees || r.matchStatus !== 'unmatched_employee') return h('span', {}, '—');
              const sel = h('select', { 'aria-label': t('time.mapTo') }) as HTMLSelectElement;
              for (const o of employees) sel.appendChild(h('option', { value: o.value }, o.label));
              const btn = button(t('time.createMapping'), async () => {
                try {
                  await session.api.call('timeMappingCreate', {
                    body: { externalId: r.externalEmployeeId, employeeId: sel.value },
                  });
                  toast(t('app.save'));
                } catch (e) {
                  toast((e as ApiError).message, 'err');
                }
              });
              return h('div', { class: 'inline-form' }, sel, btn);
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

export async function timeDevicesPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('time.devicesTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('time.devicesHint')));
  const zone = h('div', {});
  const mapZone = h('div', {});
  const canManage = session.hasPermission('time.devices_manage');

  if (canManage) {
    const code = field('time.code', { required: true });
    const label = field('time.label', { required: true });
    const kindSel = selectField('time.kind', (['clock', 'csv', 'xlsx', 'manual', 'api', 'external'] as const)
      .map((k) => ({ value: k, label: t(`time.deviceKind.${k}` as MessageKey) })));
    let siteOpts: Array<{ value: string; label: string }> = [{ value: '', label: '—' }];
    if (session.hasPermission('org.view')) {
      const sites = await session.api.call<OrgItem[]>('orgSites', { query: { limit: 200 } }).catch(() => [] as OrgItem[]);
      siteOpts = [{ value: '', label: '—' }, ...sites.map((s) => ({ value: s.id, label: s.code }))];
    }
    const siteSel = selectField('time.site', siteOpts);
    const submit = button(t('time.newDevice'), null, { variant: 'primary', type: 'submit' });
    const form = h('form', { class: 'filters' }, code.wrap, label.wrap, kindSel.wrap, siteSel.wrap, submit) as HTMLFormElement;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      void (async () => {
        try {
          await session.api.call('timeDeviceCreate', {
            body: {
              code: code.input.value.trim().toUpperCase(), label: label.input.value.trim(),
              kind: kindSel.select.value,
              ...(siteSel.select.value ? { siteId: siteSel.select.value } : {}),
            },
          });
          toast(t('app.save'));
          await load();
        } catch (e) {
          toast((e as ApiError).message, 'err');
        } finally {
          submit.disabled = false;
        }
      })();
    });
    root.appendChild(h('div', { class: 'glass card' }, form));
  }
  root.appendChild(zone);
  root.appendChild(h('h2', {}, t('time.mappings')));
  root.appendChild(mapZone);

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    mapZone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: TimeDeviceRow[] }>('timeDevices');
      zone.replaceChildren(res.items.length === 0 ? states.empty() : dataTable<TimeDeviceRow>({
        columns: [
          { key: 'code', labelKey: 'time.code', render: (r) => h('span', { class: 'mono' }, r.code) },
          { key: 'label', labelKey: 'time.label', render: (r) => r.label },
          { key: 'kind', labelKey: 'time.kind', render: (r) => t(`time.deviceKind.${r.kind}` as MessageKey) },
          { key: 'site', labelKey: 'time.site', render: (r) => r.siteCode ?? '—' },
          { key: 'tz', labelKey: 'time.timezone', render: (r) => r.timeZone ?? '—' },
          { key: 'maps', labelKey: 'time.mappings', render: (r) => String(r.mappingCount) },
          { key: 'status', labelKey: 'time.status', render: (r) => statusBadge(r.status === 'active' ? 'active' : 'archived', r.status) },
        ],
        rows: res.items,
      }));
      const maps = await session.api.call<{ items: TimeMappingRow[] }>('timeMappings');
      mapZone.replaceChildren(maps.items.length === 0 ? states.empty() : dataTable<TimeMappingRow>({
        columns: [
          { key: 'ext', labelKey: 'time.externalId', render: (r) => h('span', { class: 'mono' }, r.externalId) },
          { key: 'emp', labelKey: 'time.employee', render: (r) => h('span', {}, h('span', { class: 'mono' }, r.matricule), ` ${r.firstName} ${r.lastName}`) },
          { key: 'dev', labelKey: 'time.device', render: (r) => r.deviceCode ?? '—' },
          {
            key: 'status', labelKey: 'time.status', render: (r) => {
              if (r.status !== 'active' || !canManage) return statusBadge(r.status === 'active' ? 'active' : 'archived', r.status);
              return button(t('time.retire'), async () => {
                if (!(await confirmModal(`${t('time.retire')} — ${r.externalId} ?`, { danger: true }))) return;
                try {
                  await session.api.call('timeMappingRetire', { params: { id: r.id } });
                  toast(t('app.save'));
                  await load();
                } catch (e) {
                  toast((e as ApiError).message, 'err');
                }
              }, { variant: 'danger' });
            },
          },
        ],
        rows: maps.items,
      }));
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
      mapZone.replaceChildren(h('span', {}));
    }
  }
  await load();
  return root;
}

/** Redirection interne : /time/schedules/:id est le détail, /time/schedules la liste. */
export function timeSchedulesRoute(session: Session, id?: string): Promise<HTMLElement> {
  return id ? timeModelDetailPage(session, id) : timeModelsPage(session);
}
