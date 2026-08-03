/**
 * Demandes de congés (E11.2 via PWA) — espaces salarié / manager / RH :
 * nouvelle demande avec PRÉVISUALISATION serveur (décompte E10 réel, contrôles
 * localisés, solde avant/après, projection conditionnelle), mes demandes
 * (brouillons, suivi, retrait, confirmation, annulation par circuit),
 * demandes à traiter (avant/après, approuver/rejeter/retourner), calendrier
 * d'équipe (niveaux de visibilité, fériés, alertes de capacité E4), file RH
 * (sensibles, rétroactives, échecs d'application, délais).
 * RÈGLES : le solde ne se modifie JAMAIS ici (mouvements seuls côté serveur) ;
 * cacher un bouton n'est jamais la sécurité ; RIEN hors ligne.
 */
import { h } from '../core/dom.ts';
import { getLocale, t, type MessageKey } from '../core/i18n.ts';
import { fmtDateTime } from '../core/format.ts';
import type { Session } from '../core/session.ts';
import type {
  ApiError, LeaveCalendarOut, LeaveCheckItem, LeaveRequestDetailOut,
  LeaveRequestListRow, LeaveRequestPreviewOut, LeaveTypeRow,
} from '../core/api.ts';
import {
  button, dataTable, field, kv, pageTitle, selectField,
  stateForError, states, statusBadge, toast,
} from '../ui/kit.ts';

function tk(prefix: string, key: string): string {
  const k = (`${prefix}.${key}`) as MessageKey;
  try { return t(k); } catch { return key; }
}
const qty3 = (v: string | number | null): string =>
  v === null ? '—' : (Math.round(Number(v) * 1000) / 1000).toString();

function reqStatusBadge(status: string): HTMLElement {
  const tone = status === 'applied' || status === 'approved' ? 'active'
    : status === 'rejected' || status === 'application_failed' ? 'retired'
      : status === 'cancelled' || status === 'expired' ? 'retired' : 'draft';
  return statusBadge(tone, tk('lr.st', status));
}

function labelOf(r: Pick<LeaveRequestListRow, 'typeCode' | 'labelFr' | 'labelEn'>, locale: string): string {
  const base = locale === 'en' ? r.labelEn : r.labelFr;
  return r.typeCode ? `${r.typeCode} — ${base}` : base;
}

function checksList(checks: LeaveCheckItem[], locale: string): HTMLElement {
  if (checks.length === 0) return h('p', { class: 'section-note' }, t('lr.noBlocking'));
  const ul = h('ul', { class: 'check-list' });
  for (const c of checks) {
    ul.appendChild(h('li', { class: c.level === 'error' ? 'check-error' : 'check-warning' },
      statusBadge(c.level === 'error' ? 'retired' : 'draft', c.level === 'error' ? '✕' : '⚠'),
      ` ${locale === 'en' ? c.en : c.fr} `,
      h('span', { class: 'mono muted' }, `(${c.code})`)));
  }
  return ul;
}

function previewCard(p: LeaveRequestPreviewOut['preview'], locale: string): HTMLElement {
  const card = h('div', { class: 'glass card' });
  card.appendChild(kv([
    [t('lr.quantity'), `${qty3(p.quantity)} ${tk('lv.unit', p.unit)}`],
    [t('lr.available'), qty3(p.available)],
    [t('lr.afterAvailable'), qty3(p.afterAvailable)],
    [t('lr.projected'), qty3(p.projectedAtStart)],
    [t('lr.circuit'), h('span', { class: 'mono' }, p.circuit)],
  ]));
  card.appendChild(h('p', { class: 'section-note' }, t('lr.projectionNote')));
  card.appendChild(h('h3', { class: 'section-title' }, t('lr.checks')));
  card.appendChild(p.blocking ? h('p', { class: 'error-text' }, t('lr.blocking')) : h('span', {}, ''));
  card.appendChild(checksList(p.checks, locale));
  card.appendChild(h('h3', { class: 'section-title' }, t('lr.countDetail')));
  const ul = h('ul', { class: 'count-detail' });
  for (const d of p.detail) {
    ul.appendChild(h('li', {}, h('span', { class: 'mono' }, `${d.date} · ${d.counted}`), ` — ${d.why}`));
  }
  card.appendChild(ul);
  return card;
}

// ---------------------------------------------------------------------------
// Nouvelle demande (salarié ; pour un tiers avec la permission dédiée)
// ---------------------------------------------------------------------------

export async function leaveRequestNewPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('lr.title.new')));
  const locale = getLocale();
  let types: LeaveTypeRow[] = [];
  try {
    types = (await session.api.call<{ items: LeaveTypeRow[] }>('leaveTypes')).items.filter((x) => x.status === 'active');
  } catch (e) {
    root.appendChild(stateForError(e as ApiError));
    return root;
  }
  const type = selectField('lr.type', types.map((x) => ({ value: x.id, label: `${x.code} — ${locale === 'en' ? x.labelEn : x.labelFr}` })));
  const start = field('lr.startDate', { type: 'date', required: true });
  const end = field('lr.endDate', { type: 'date', required: true });
  const halfS = h('label', { class: 'field' }, h('input', { type: 'checkbox' }), ` ${t('lr.halfDayStart')}`);
  const halfE = h('label', { class: 'field' }, h('input', { type: 'checkbox' }), ` ${t('lr.halfDayEnd')}`);
  const hours = field('lr.hours', { type: 'number', placeholder: '4' });
  const comment = field('lr.comment', {});
  const forOthers = session.hasPermission('leave.request_for_others');
  const employeeId = field('lr.forEmployee', { placeholder: forOthers ? 'UUID (optionnel)' : '' });
  const reason = field('lr.onBehalfReason', {});
  const previewZone = h('div', {});
  let currentId: string | null = null;

  const save = button(t('lr.createDraft'), null, { variant: 'primary', type: 'submit' });
  const previewBtn = button(t('lr.preview'), async () => {
    if (!currentId) { toast(t('lr.createDraft'), 'err'); return; }
    await refreshPreview();
  }, { variant: 'ghost' });
  const submitBtn = button(t('lr.submit'), async () => {
    if (!currentId) return;
    try {
      const out = await session.api.call<{ version: number }>('leaveRequestSubmit', { params: { id: currentId } });
      toast(t('lr.submittedOk').replace('{v}', String(out.version)));
      location.hash = '#/leave/requests/mine';
    } catch (e) { toast((e as ApiError).message, 'err'); }
  }, { variant: 'primary' });

  async function refreshPreview(): Promise<void> {
    if (!currentId) return;
    previewZone.replaceChildren(states.loading());
    try {
      const out = await session.api.call<LeaveRequestPreviewOut>('leaveRequestPreview', { params: { id: currentId } });
      previewZone.replaceChildren(previewCard(out.preview, locale));
    } catch (e) { previewZone.replaceChildren(stateForError(e as ApiError)); }
  }

  const kids: (HTMLElement | string)[] = [type.wrap, start.wrap, end.wrap, halfS, halfE, hours.wrap, comment.wrap];
  if (forOthers) { kids.push(employeeId.wrap, reason.wrap); }
  kids.push(save, previewBtn, submitBtn);
  const form = h('form', { class: 'filters' }, ...kids) as HTMLFormElement;
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void (async () => {
      try {
        const body: Record<string, unknown> = {
          typeId: type.select.value, startDate: start.input.value, endDate: end.input.value,
          halfDayStart: (halfS.querySelector('input') as HTMLInputElement).checked,
          halfDayEnd: (halfE.querySelector('input') as HTMLInputElement).checked,
        };
        if (hours.input.value) body['hours'] = Number(hours.input.value);
        if (comment.input.value) body['comment'] = comment.input.value;
        if (forOthers && employeeId.input.value.trim()) {
          body['employeeId'] = employeeId.input.value.trim();
          body['onBehalfReason'] = reason.input.value.trim();
        }
        if (currentId) {
          await session.api.call('leaveRequestUpdate', { params: { id: currentId }, body });
        } else {
          const out = await session.api.call<{ id: string }>('leaveRequestCreate', { body });
          currentId = out.id;
        }
        toast(t('app.save'));
        await refreshPreview();
      } catch (e) { toast((e as ApiError).message, 'err'); }
    })();
  });
  root.appendChild(h('div', { class: 'glass card' }, form));
  root.appendChild(previewZone);
  return root;
}

// ---------------------------------------------------------------------------
// Mes demandes : suivi, retrait, confirmation, annulation par circuit
// ---------------------------------------------------------------------------

export async function leaveMyRequestsPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('lr.title.mine'),
    button(t('nav.leaveNew'), () => { location.hash = '#/leave/requests/new'; }, { variant: 'primary' })));
  const locale = getLocale();
  const listZone = h('div', {});
  const detailZone = h('div', {});
  root.appendChild(listZone);
  root.appendChild(detailZone);

  async function openDetail(id: string): Promise<void> {
    detailZone.replaceChildren(states.loading());
    try {
      const out = await session.api.call<LeaveRequestDetailOut>('leaveRequestDetail', { params: { id } });
      const r = out.request;
      const card = h('div', { class: 'glass card' });
      card.appendChild(h('h3', { class: 'section-title' }, `${labelOf(r, locale)} · v${r.version}`));
      card.appendChild(kv([
        [t('lr.status'), reqStatusBadge(r.status)],
        [t('lr.period'), r.startDate ? `${r.startDate} → ${r.endDate}` : '—'],
        [t('lr.quantity'), r.quantity === null ? '—' : `${qty3(r.quantity)} ${tk('lv.unit', r.unit ?? '')}`],
      ]));
      const actions = h('div', { class: 'filters' });
      if (['draft', 'returned', 'submitted', 'in_review'].includes(r.status)) {
        actions.appendChild(button(t('lr.withdraw'), async () => {
          try {
            await session.api.call('leaveRequestWithdraw', { params: { id } });
            toast(t('lr.withdrawnOk'));
            await load(); detailZone.replaceChildren();
          } catch (e) { toast((e as ApiError).message, 'err'); }
        }, { variant: 'ghost' }));
      }
      if (['draft', 'returned'].includes(r.status) && !r.confirmedAt) {
        actions.appendChild(button(t('lr.confirm'), async () => {
          try {
            await session.api.call('leaveRequestConfirm', { params: { id } });
            toast(t('lr.confirmedOk'));
            await openDetail(id);
          } catch (e) { toast((e as ApiError).message, 'err'); }
        }, { variant: 'ghost' }));
      }
      if (r.status === 'applied') {
        const reason = field('lr.cancelReason', {});
        actions.appendChild(reason.wrap);
        actions.appendChild(button(t('lr.cancelApproved'), async () => {
          try {
            await session.api.call('leaveRequestCancelApproved', { params: { id }, body: { reason: reason.input.value } });
            toast(t('lr.cancelRequestedOk'));
            await openDetail(id);
          } catch (e) { toast((e as ApiError).message, 'err'); }
        }, { variant: 'ghost' }));
      }
      if (r.status === 'application_failed') {
        actions.appendChild(button(t('lr.retry'), async () => {
          try {
            await session.api.call('leaveRequestApply', { params: { id } });
            toast(t('lr.appliedOk'));
            await load(); await openDetail(id);
          } catch (e) { toast((e as ApiError).message, 'err'); }
        }, { variant: 'primary' }));
      }
      card.appendChild(actions);
      // Justificatif (base64) : la pièce d'un type confidentiel est SENSIBLE d'office.
      if (['draft', 'returned', 'submitted', 'in_review'].includes(r.status)) {
        const fileInput = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg' }) as HTMLInputElement;
        const attach = button(t('lr.attach'), async () => {
          const f = fileInput.files?.[0];
          if (!f) return;
          const buf = new Uint8Array(await f.arrayBuffer());
          let bin = '';
          for (const b of buf) bin += String.fromCharCode(b);
          try {
            await session.api.call('leaveRequestAttachmentAdd', {
              params: { id },
              body: { filename: f.name, mime: f.type || 'application/pdf', contentBase64: btoa(bin) },
            });
            toast(t('app.save'));
            await openDetail(id);
          } catch (e) { toast((e as ApiError).message, 'err'); }
        }, { variant: 'ghost' });
        card.appendChild(h('div', { class: 'filters' }, fileInput, attach));
      }
      if (r.attachments.length > 0) {
        card.appendChild(h('h3', { class: 'section-title' }, t('lr.attachments')));
        for (const a of r.attachments) {
          card.appendChild(h('p', {}, h('span', { class: 'mono' }, a.filename),
            ` · ${tk('lr', a.verifiedStatus === 'accepted' ? 'attachmentAccepted' : a.verifiedStatus === 'rejected' ? 'attachmentRejected' : 'attachmentPresent')}`));
        }
      }
      // Version courante : contrôles figés + décompte.
      const cur = r.versions.find((v) => v.version === r.version);
      if (cur) {
        card.appendChild(h('h3', { class: 'section-title' }, `${t('lr.checks')} (v${cur.version})`));
        card.appendChild(checksList(cur.checks, locale));
      }
      card.appendChild(h('h3', { class: 'section-title' }, t('lr.history')));
      const ul = h('ul', { class: 'count-detail' });
      for (const ev of r.events) {
        ul.appendChild(h('li', {}, h('span', { class: 'mono' }, fmtDateTime(ev.createdAt)),
          ` — ${tk('lr.ev', ev.event)}${ev.version ? ` (v${ev.version})` : ''}`));
      }
      card.appendChild(ul);
      detailZone.replaceChildren(card);
    } catch (e) { detailZone.replaceChildren(stateForError(e as ApiError)); }
  }

  async function load(): Promise<void> {
    listZone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: LeaveRequestListRow[] }>('leaveRequestsMine');
      if (res.items.length === 0) { listZone.replaceChildren(h('p', { class: 'section-note' }, t('lr.noRequests'))); return; }
      listZone.replaceChildren(dataTable<LeaveRequestListRow>({
        columns: [
          { key: 't', labelKey: 'lr.type', render: (r) => labelOf(r, locale) },
          { key: 'p', labelKey: 'lr.period', render: (r) => r.startDate ? `${r.startDate} → ${r.endDate}` : '—' },
          { key: 'q', labelKey: 'lr.quantity', render: (r) => r.quantity === null ? '—' : qty3(r.quantity) },
          { key: 'v', labelKey: 'lr.version', render: (r) => h('span', { class: 'mono' }, `v${r.version}`) },
          { key: 's', labelKey: 'lr.status', render: (r) => reqStatusBadge(r.status) },
          {
            key: 'a', labelKey: 'app.actions',
            render: (r) => button(t('app.details'), () => { void openDetail(r.id); }, { variant: 'ghost' }),
          },
        ],
        rows: res.items,
      }));
    } catch (e) { listZone.replaceChildren(stateForError(e as ApiError)); }
  }
  await load();
  return root;
}

// ---------------------------------------------------------------------------
// Demandes à traiter (manager) / File RH — décision avec avant/après
// ---------------------------------------------------------------------------

export async function leaveTeamRequestsPage(session: Session, scope: 'team' | 'queue'): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t(scope === 'team' ? 'lr.title.team' : 'lr.title.queue')));
  const locale = getLocale();
  const filters = h('div', { class: 'filters' });
  const zone = h('div', {});
  const detailZone = h('div', {});
  let sensitiveOnly = false, retroOnly = false, failedOnly = false;

  if (scope === 'queue') {
    const mk = (labelKey: MessageKey, set: (v: boolean) => void): HTMLElement => {
      const wrap = h('label', { class: 'field' }, h('input', { type: 'checkbox' }), ` ${t(labelKey)}`);
      (wrap.querySelector('input') as HTMLInputElement).addEventListener('change', (ev) => {
        set((ev.target as HTMLInputElement).checked);
        void load();
      });
      return wrap;
    };
    filters.appendChild(mk('lr.filterSensitive', (v) => { sensitiveOnly = v; }));
    filters.appendChild(mk('lr.filterRetro', (v) => { retroOnly = v; }));
    filters.appendChild(mk('lr.filterFailed', (v) => { failedOnly = v; }));
  }
  root.appendChild(filters);
  root.appendChild(zone);
  root.appendChild(detailZone);

  async function decide(id: string, action: 'approve' | 'reject' | 'return', comment: string): Promise<void> {
    try {
      await session.api.call('leaveRequestDecide', { params: { id }, body: { action, comment: comment || undefined } });
      toast(t('lr.decidedOk'));
      await load(); detailZone.replaceChildren();
    } catch (e) { toast((e as ApiError).message, 'err'); }
  }

  async function openDetail(row: LeaveRequestListRow): Promise<void> {
    detailZone.replaceChildren(states.loading());
    try {
      const out = await session.api.call<LeaveRequestDetailOut>('leaveRequestDetail', { params: { id: row.id } });
      const r = out.request;
      const card = h('div', { class: 'glass card' });
      card.appendChild(h('h3', { class: 'section-title' },
        `${r.matricule ?? ''} ${r.lastName ?? ''} ${r.firstName ?? ''} · ${labelOf(r, locale)} · v${r.version}`));
      // Avant/après : la PRÉVISUALISATION serveur (portée réelle) donne le solde.
      try {
        const pv = await session.api.call<LeaveRequestPreviewOut>('leaveRequestPreview', { params: { id: row.id } });
        card.appendChild(kv([
          [t('lr.beforeAfter'), `${qty3(pv.preview.available)} → ${qty3(pv.preview.afterAvailable)}`],
          [t('lr.quantity'), `${qty3(pv.preview.quantity)} ${tk('lv.unit', pv.preview.unit)}`],
          [t('lr.circuit'), h('span', { class: 'mono' }, pv.preview.circuit)],
        ]));
        card.appendChild(checksList(pv.preview.checks, locale));
      } catch { /* demande déjà décidée : la version figée fait foi */ }
      if (['submitted', 'in_review'].includes(r.status)) {
        const comment = field('lr.decisionComment', {});
        card.appendChild(comment.wrap);
        card.appendChild(h('div', { class: 'filters' },
          button(t('lr.approve'), () => { void decide(r.id, 'approve', comment.input.value); }, { variant: 'primary' }),
          button(t('lr.reject'), () => { void decide(r.id, 'reject', comment.input.value); }, { variant: 'ghost' }),
          button(t('lr.return'), () => { void decide(r.id, 'return', comment.input.value); }, { variant: 'ghost' })));
      }
      if (scope === 'queue' && r.status === 'application_failed') {
        card.appendChild(button(t('lr.retry'), async () => {
          try {
            await session.api.call('leaveRequestApply', { params: { id: r.id } });
            toast(t('lr.appliedOk'));
            await load();
          } catch (e) { toast((e as ApiError).message, 'err'); }
        }, { variant: 'primary' }));
      }
      if (scope === 'queue' && r.status === 'returned') {
        const reason = field('lr.expireReason', {});
        card.appendChild(h('div', { class: 'filters' }, reason.wrap,
          button(t('lr.expire'), async () => {
            try {
              await session.api.call('leaveRequestExpire', { params: { id: r.id }, body: { reason: reason.input.value } });
              toast(t('app.save'));
              await load(); detailZone.replaceChildren();
            } catch (e) { toast((e as ApiError).message, 'err'); }
          }, { variant: 'ghost' })));
      }
      detailZone.replaceChildren(card);
    } catch (e) { detailZone.replaceChildren(stateForError(e as ApiError)); }
  }

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const query: Record<string, string> = {};
      if (sensitiveOnly) query['sensitive'] = '1';
      if (retroOnly) query['retro'] = '1';
      if (failedOnly) query['failed'] = '1';
      const res = await session.api.call<{ items: LeaveRequestListRow[]; delayDays: number | null }>(
        scope === 'team' ? 'leaveRequestsTeam' : 'leaveRequestsQueue', { query });
      const head = h('div', {});
      if (res.delayDays !== null) {
        head.appendChild(h('p', { class: 'section-note' }, `${t('lr.delay')} : ${res.delayDays}`));
      }
      if (res.items.length === 0) {
        zone.replaceChildren(head, h('p', { class: 'section-note' }, t('lr.noRequests')));
        return;
      }
      zone.replaceChildren(head, dataTable<LeaveRequestListRow>({
        columns: [
          { key: 'e', labelKey: 'lr.employee', render: (r) => `${r.matricule ?? ''} ${r.lastName ?? ''} ${r.firstName ?? ''}` },
          { key: 't', labelKey: 'lr.type', render: (r) => labelOf(r, locale) },
          { key: 'p', labelKey: 'lr.period', render: (r) => r.startDate ? `${r.startDate} → ${r.endDate}` : '—' },
          { key: 'q', labelKey: 'lr.quantity', render: (r) => r.quantity === null ? '—' : qty3(r.quantity) },
          {
            key: 'flags', labelKey: 'lr.checks',
            render: (r) => {
              const wrap = h('span', { class: 'filters' });
              if (r.retroactive) wrap.appendChild(statusBadge('draft', t('lr.retroactive')));
              if (r.onBehalf) wrap.appendChild(statusBadge('draft', t('lr.onBehalf')));
              if ((r.attachmentCount ?? 0) > 0) wrap.appendChild(statusBadge('draft', t('lr.attachmentPresent')));
              return wrap;
            },
          },
          { key: 's', labelKey: 'lr.status', render: (r) => reqStatusBadge(r.status) },
          {
            key: 'a', labelKey: 'app.actions',
            render: (r) => button(t('app.details'), () => { void openDetail(r); }, { variant: 'ghost' }),
          },
        ],
        rows: res.items,
      }));
    } catch (e) { zone.replaceChildren(stateForError(e as ApiError)); }
  }
  await load();
  return root;
}

// ---------------------------------------------------------------------------
// Calendrier d'équipe : visibilité par NIVEAU, fériés, capacité, export
// ---------------------------------------------------------------------------

export async function leaveCalendarPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('lr.title.calendar')));
  const locale = getLocale();
  const today = new Date();
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const monday = new Date(today);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const from = field('lr.calFrom', { type: 'date' });
  const to = field('lr.calTo', { type: 'date' });
  from.input.value = iso(monday);
  const friday = new Date(monday);
  friday.setUTCDate(friday.getUTCDate() + 27);
  to.input.value = iso(friday);
  const zone = h('div', {});
  const loadBtn = button(t('lr.calLoad'), () => { void load(); }, { variant: 'primary' });
  const exportBtn = session.hasPermission('leave.calendar_export')
    ? button(t('lr.calExport'), async () => {
      try {
        const out = await session.api.call<{ csv: string }>('leaveCalendarExport', {
          query: { from: from.input.value, to: to.input.value },
        });
        const blob = new Blob([out.csv], { type: 'text/csv' });
        const a = h('a', { href: URL.createObjectURL(blob), download: `calendrier-${from.input.value}.csv` }) as HTMLAnchorElement;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (e) { toast((e as ApiError).message, 'err'); }
    }, { variant: 'ghost' })
    : null;
  const bar = h('div', { class: 'filters' }, from.wrap, to.wrap, loadBtn);
  if (exportBtn) bar.appendChild(exportBtn);
  root.appendChild(bar);
  root.appendChild(zone);

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const out = await session.api.call<LeaveCalendarOut>('leaveCalendar', {
        query: { from: from.input.value, to: to.input.value },
      });
      const c = out.calendar;
      const wrap = h('div', {});
      if (c.holidays.length > 0) {
        wrap.appendChild(h('p', { class: 'section-note' },
          `${t('lr.calHolidays')} : ${c.holidays.map((x) => `${x.date} (${x.label})`).join(' · ')}`));
      }
      if (c.alerts.length > 0) {
        const ul = h('ul', { class: 'check-list' });
        for (const a of c.alerts) {
          ul.appendChild(h('li', { class: a.level === 'alert' ? 'check-error' : 'check-warning' },
            h('span', { class: 'mono' }, a.date), ' — ',
            t('lr.calAlert').replace('{present}', String(a.present)).replace('{min}', String(a.minPresence))));
        }
        wrap.appendChild(h('h3', { class: 'section-title' }, t('lr.calAlerts')));
        wrap.appendChild(ul);
      }
      if (c.entries.length === 0) {
        wrap.appendChild(h('p', { class: 'section-note' }, t('lr.noEntries')));
        zone.replaceChildren(wrap);
        return;
      }
      const byEmp = new Map(c.employees.map((e) => [e.id, e]));
      wrap.appendChild(dataTable<LeaveCalendarOut['calendar']['entries'][number]>({
        columns: [
          {
            key: 'e', labelKey: 'lr.employee',
            render: (r) => {
              const emp = byEmp.get(r.employeeId);
              return emp ? `${emp.matricule} ${emp.lastName} ${emp.firstName}` : '—';
            },
          },
          { key: 'p', labelKey: 'lr.period', render: (r) => `${r.startDate} → ${r.endDate}` },
          {
            key: 'l', labelKey: 'lr.type',
            render: (r) => r.labelMode === 'detail'
              ? `${r.typeCode} — ${locale === 'en' ? r.labelEn : r.labelFr}`
              : (locale === 'en' ? r.labelEn : r.labelFr),
          },
          {
            key: 's', labelKey: 'lr.status',
            render: (r) => statusBadge(r.status === 'approved' ? 'active' : 'draft',
              r.status === 'approved' ? t('lr.calApproved') : t('lr.calPending')),
          },
        ],
        rows: c.entries,
      }));
      zone.replaceChildren(wrap);
    } catch (e) { zone.replaceChildren(stateForError(e as ApiError)); }
  }
  await load();
  return root;
}
