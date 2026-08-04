/**
 * Clôture des congés, intégration présence & reporting (E11.3 via PWA).
 *  - Périodes de congés : pré-clôture EXHAUSTIVE (bloquants / avertissements),
 *    clôture à empreinte SHA-256 REPRODUCTIBLE (vérifiable à la demande),
 *    réouverture par circuit E3 motivé (l'ancienne clôture DEMEURE), exports
 *    préparatoires paie SANS MONTANT (CSV/JSON versionnés, idempotents,
 *    téléchargement audité).
 *  - Intégration présence : faits d'absence par statut, impacts, absences EN
 *    ATTENTE de réouverture E10, reprise explicite idempotente, comparaison
 *    avant/après par le détail de journée E10 (versions conservées).
 *  - Rapports : agrégats bornés aux portées réelles — JAMAIS un motif médical.
 * RÈGLES : rien hors ligne ; masquer un bouton n'est jamais la sécurité.
 */
import { h } from '../core/dom.ts';
import { t, type MessageKey } from '../core/i18n.ts';
import { fmtDateTime } from '../core/format.ts';
import type { Session } from '../core/session.ts';
import type {
  ApiError, LeaveCloseRow, LeaveIntegrationOut, LeavePeriodRow, LeavePrecloseCheck,
  LeavePrecloseOut, LeavePrepExportRow, LeaveReportOut,
} from '../core/api.ts';
import {
  button, dataTable, field, kv, pageTitle, stateForError, states, statusBadge, toast,
} from '../ui/kit.ts';

function tk(prefix: string, key: string): string {
  const k = (`${prefix}.${key}`) as MessageKey;
  try { return t(k); } catch { return key; }
}
const q3 = (v: unknown): string => (Math.round(Number(v) * 1000) / 1000).toString();

function periodBadge(status: string): HTMLElement {
  const tone = status === 'open' || status === 'reopened' ? 'active' : status === 'closed' ? 'draft' : 'retired';
  return statusBadge(tone, tk('lc.pst', status));
}

function checksTable(checks: LeavePrecloseCheck[]): HTMLElement {
  if (checks.length === 0) return h('p', { class: 'section-note' }, t('lc.noChecks'));
  return dataTable<LeavePrecloseCheck>({
    columns: [
      { key: 'c', labelKey: 'lc.checkCode', render: (c) => tk('lc.ctl', c.code) },
      { key: 'n', labelKey: 'lc.checkCount', render: (c) => String(c.count) },
      {
        key: 'l', labelKey: 'lc.checkLevel',
        render: (c) => statusBadge(c.level === 'blocking' ? 'retired' : 'draft',
          c.level === 'blocking' ? t('lc.blocking') : t('lc.warning')),
      },
    ],
    rows: checks,
  });
}

// ---------------------------------------------------------------------------
// Périodes de congés : pré-clôture, clôture, réouverture, exports
// ---------------------------------------------------------------------------

export async function leaveClosePage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('lc.title')));
  root.appendChild(h('p', { class: 'section-note' }, t('lc.hint')));
  const canManage = session.hasPermission('leave.period_manage');
  const canClose = session.hasPermission('leave.close_run');
  const canReopen = session.hasPermission('leave.reopen');
  const canExport = session.hasPermission('leave.export_create');
  const canDownload = session.hasPermission('leave.export_download');
  const zone = h('div', {});
  const detail = h('div', {});

  if (canManage) {
    const label = field('lc.pLabel', { required: true });
    const from = field('lc.from', { type: 'date', required: true });
    const to = field('lc.to', { type: 'date', required: true });
    const submit = button(t('lc.pNew'), null, { variant: 'primary', type: 'submit' });
    const form = h('form', { class: 'filters' }, label.wrap, from.wrap, to.wrap, submit) as HTMLFormElement;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void (async () => {
        try {
          await session.api.call('leavePeriodCreate', {
            body: { label: label.input.value.trim(), periodStart: from.input.value, periodEnd: to.input.value },
          });
          toast(t('app.save'));
          await load();
        } catch (e) { toast((e as ApiError).message, 'err'); }
      })();
    });
    root.appendChild(h('div', { class: 'glass card' }, form));
  }
  root.appendChild(zone);
  root.appendChild(detail);

  async function showPreclose(p: LeavePeriodRow): Promise<void> {
    detail.replaceChildren(states.loading());
    try {
      const pre = await session.api.call<LeavePrecloseOut>('leavePreclose', { params: { id: p.id } });
      const pc = pre.preclose;
      const card = h('div', { class: 'glass card' },
        h('h3', { class: 'section-title' }, `${t('lc.precloseTitle')} — ${pc.label} (r${pc.revision})`),
        h('p', { class: 'section-note' }, t('lc.precloseHint')),
        h('p', { class: 'section-note' }, pc.blocking.length === 0
          ? t('lc.precloseClosable')
          : t('lc.precloseBlocked', { n: pc.blocking.length })));
      card.appendChild(checksTable([...pc.blocking, ...pc.warnings]));
      if (canClose && (p.status === 'open' || p.status === 'reopened')) {
        const confirmWrap = h('label', { class: 'field' }, h('input', { type: 'checkbox' }), ` ${t('lc.confirmWarnings')}`);
        const confirmInput = confirmWrap.querySelector('input') as HTMLInputElement;
        card.appendChild(h('div', { class: 'filters' }, confirmWrap,
          button(t('lc.close'), async () => {
            try {
              const out = await session.api.call<{ closeNo: number; fingerprint: string }>('leavePeriodClose', {
                params: { id: p.id }, body: { confirmWarnings: confirmInput.checked },
              });
              toast(t('lc.closedOk', { no: out.closeNo }));
              detail.replaceChildren();
              await load();
            } catch (e) { toast((e as ApiError).message, 'err'); }
          }, { variant: 'primary' })));
      }
      detail.replaceChildren(card);
    } catch (e) { detail.replaceChildren(stateForError(e as ApiError)); }
  }

  async function showCloses(p: LeavePeriodRow): Promise<void> {
    detail.replaceChildren(states.loading());
    try {
      const closes = await session.api.call<{ items: LeaveCloseRow[] }>('leavePeriodCloses', { params: { id: p.id } });
      if (closes.items.length === 0) {
        detail.replaceChildren(h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('lc.noClose'))));
        return;
      }
      const blocks: HTMLElement[] = [];
      for (const c of closes.items) {
        const card = h('div', { class: 'glass card' },
          h('h3', { class: 'section-title' }, `${p.label} — ${t('lc.closeNo')}${c.closeNo} `,
            statusBadge(c.status === 'active' ? 'active' : 'retired',
              c.status === 'active' ? t('lc.closeActive') : t('lc.closeSuperseded'))),
          kv([
            [t('lc.engine'), h('span', { class: 'mono' }, c.engineVersion)],
            [t('lc.fingerprint'), h('span', { class: 'mono' }, `${c.fingerprint.slice(0, 24)}…`)],
            [t('lc.counters'), `${c.employeesCount} · ${c.linesCount} · ${c.movementsCount}`],
            [t('lc.closedAt'), fmtDateTime(c.closedAt)],
          ]));
        const totals = Object.entries(c.totals);
        if (totals.length > 0) {
          card.appendChild(h('p', { class: 'section-note' },
            totals.map(([unit, v]) => `${tk('lv.unit', unit)} : ${q3(v.accrued)} / ${q3(v.consumed)} / ${q3(v.available)}`).join(' · ')));
        }
        card.appendChild(h('div', { class: 'filters' },
          button(t('lc.verify'), async () => {
            try {
              const v = await session.api.call<{ match: boolean }>('leaveCloseVerify', { params: { id: c.id } });
              toast(v.match ? t('lc.verifyOk') : t('lc.verifyKo'), v.match ? 'ok' : 'err');
            } catch (e) { toast((e as ApiError).message, 'err'); }
          }, { variant: 'ghost' }),
          ...(canExport && c.status === 'active' ? [
            button(t('lc.exportCsv'), () => void generate(c.id, 'csv', p), { variant: 'ghost' }),
            button(t('lc.exportJson'), () => void generate(c.id, 'json', p), { variant: 'ghost' }),
          ] : [])));
        try {
          const exps = await session.api.call<{ items: LeavePrepExportRow[] }>('leaveCloseExports', { params: { id: c.id } });
          if (exps.items.length > 0) {
            card.appendChild(h('h3', { class: 'section-title' }, t('lc.exports')));
            card.appendChild(h('p', { class: 'section-note' }, t('lc.exportsNote')));
            card.appendChild(dataTable<LeavePrepExportRow>({
              columns: [
                { key: 'f', labelKey: 'lc.exportSchema', render: (x) => h('span', { class: 'mono' }, `${x.schemaVersion} · ${x.format} · r${x.revision}`) },
                {
                  key: 's', labelKey: 'lc.status',
                  render: (x) => statusBadge(x.status === 'active' ? 'active' : 'retired',
                    x.status === 'active' ? t('lc.closeActive') : t('lc.closeSuperseded')),
                },
                { key: 'sha', labelKey: 'lc.fingerprint', render: (x) => h('span', { class: 'mono' }, `${x.sha256.slice(0, 16)}…`) },
                { key: 'tc', labelKey: 'lc.timeCloses', render: (x) => String(x.timeCloses.length) },
                { key: 'at', labelKey: 'lc.generatedAt', render: (x) => fmtDateTime(x.generatedAt) },
                {
                  key: 'dl', labelKey: 'lc.download',
                  render: (x) => canDownload ? button(t('lc.download'), async () => {
                    try {
                      const d = await session.api.call<{ filename: string; format: string; contentBase64: string }>(
                        'leavePrepExportDownload', { params: { id: x.id } });
                      const bytes = Uint8Array.from(atob(d.contentBase64), (ch) => ch.charCodeAt(0));
                      const url = URL.createObjectURL(new Blob([bytes], { type: d.format === 'json' ? 'application/json' : 'text/csv' }));
                      const a = h('a', { href: url, download: d.filename }) as HTMLAnchorElement;
                      a.click();
                      URL.revokeObjectURL(url);
                    } catch (e) { toast((e as ApiError).message, 'err'); }
                  }, { variant: 'ghost' }) : h('span', {}, '—'),
                },
              ],
              rows: exps.items,
            }));
          }
        } catch { /* liste facultative selon la permission */ }
        blocks.push(card);
      }
      detail.replaceChildren(...blocks);
    } catch (e) { detail.replaceChildren(stateForError(e as ApiError)); }
  }

  async function generate(closeId: string, format: 'csv' | 'json', p: LeavePeriodRow): Promise<void> {
    try {
      const out = await session.api.call<{ revision: number; reused: boolean }>(
        'leaveCloseExportCreate', { params: { id: closeId }, body: { format } });
      toast(out.reused ? t('lc.exportReused') : t('lc.exportGenerated', { rev: out.revision }));
      await showCloses(p);
    } catch (e) { toast((e as ApiError).message, 'err'); }
  }

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: LeavePeriodRow[] }>('leavePeriods');
      if (res.items.length === 0) {
        zone.replaceChildren(h('div', { class: 'glass card' }, h('p', { class: 'section-note' }, t('lc.noPeriodYet'))));
        return;
      }
      zone.replaceChildren(dataTable<LeavePeriodRow>({
        columns: [
          { key: 'l', labelKey: 'lc.pLabel', render: (p) => p.label },
          { key: 'r', labelKey: 'lc.pRange', render: (p) => h('span', { class: 'mono' }, `${p.periodStart} → ${p.periodEnd}`) },
          { key: 's', labelKey: 'lc.status', render: (p) => periodBadge(p.status) },
          { key: 'rev', labelKey: 'lc.pRevision', render: (p) => `r${p.revision}` },
          { key: 'c', labelKey: 'lc.pCloses', render: (p) => String(p.closeCount) },
          {
            key: 'fp', labelKey: 'lc.fingerprint',
            render: (p) => p.activeFingerprint ? h('span', { class: 'mono' }, `${p.activeFingerprint.slice(0, 12)}…`) : h('span', {}, '—'),
          },
          {
            key: 'act', labelKey: 'app.actions',
            render: (p) => {
              const wrap = h('span', { class: 'filters' });
              wrap.appendChild(button(t('lc.precloseTitle'), () => void showPreclose(p), { variant: 'ghost' }));
              if (p.closeCount > 0) wrap.appendChild(button(t('lc.closes'), () => void showCloses(p), { variant: 'ghost' }));
              if (canReopen && p.status === 'closed') {
                wrap.appendChild(button(t('lc.reopen'), async () => {
                  const reason = window.prompt(t('lc.reopenReason'));
                  if (!reason || reason.trim().length < 3) return;
                  try {
                    await session.api.call('leavePeriodReopen', { params: { id: p.id }, body: { reason: reason.trim() } });
                    toast(t('lc.reopenRequested'));
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
  await load();
  return root;
}

// ---------------------------------------------------------------------------
// Intégration présence : suivi, en attente, reprise idempotente
// ---------------------------------------------------------------------------

export async function leaveIntegrationPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('li.title')));
  root.appendChild(h('p', { class: 'section-note' }, t('li.hint')));
  const canRun = session.hasPermission('leave.integration_run');
  const today = new Date();
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const from = field('lc.from', { type: 'date', required: true });
  const to = field('lc.to', { type: 'date', required: true });
  from.input.value = iso(first);
  to.input.value = iso(last);
  const go = button(t('app.search'), null, { variant: 'primary', type: 'submit' });
  const runBtn = canRun ? button(t('li.run'), async () => {
    try {
      const out = await session.api.call<{ activated: number; integrated: number; recalculated: number; resolvedAnomalies: number; stillPending: number }>(
        'leaveIntegrationRun', { body: { from: from.input.value, to: to.input.value } });
      toast(t('li.runDone', { a: out.activated, i: out.integrated, p: out.stillPending }));
      await load();
    } catch (e) { toast((e as ApiError).message, 'err'); }
  }, { variant: 'ghost' }) : null;
  const form = h('form', { class: 'filters' }, from.wrap, to.wrap, go) as HTMLFormElement;
  if (runBtn) form.appendChild(runBtn);
  root.appendChild(h('div', { class: 'glass card' }, form));
  const zone = h('div', {});
  root.appendChild(zone);

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const out = await session.api.call<LeaveIntegrationOut>('leaveIntegration', {
        query: { from: from.input.value, to: to.input.value },
      });
      const i = out.integration;
      const wrap = h('div', {});
      const factsCard = h('div', { class: 'glass card' }, h('h3', { class: 'section-title' }, t('li.facts')));
      factsCard.appendChild(h('p', { class: 'section-note' }, t('li.factsNote')));
      factsCard.appendChild(kv(i.facts.length > 0
        ? i.facts.map((f) => [tk('li.fst', f.status), String(f.count)] as [string, string])
        : [[t('li.none'), '0']]));
      factsCard.appendChild(h('h3', { class: 'section-title' }, t('li.impacts')));
      factsCard.appendChild(kv(i.impacts.length > 0
        ? i.impacts.map((x) => [tk('li.imp', x.impact), String(x.count)] as [string, string])
        : [[t('li.none'), '0']]));
      wrap.appendChild(factsCard);
      if (i.pending.length > 0) {
        const pendCard = h('div', { class: 'glass card' },
          h('h3', { class: 'section-title' }, t('li.pendingTitle')),
          h('p', { class: 'section-note' }, t('li.pendingNote')));
        pendCard.appendChild(dataTable<LeaveIntegrationOut['integration']['pending'][number]>({
          columns: [
            { key: 'm', labelKey: 'emp.matricule', render: (r) => h('span', { class: 'mono' }, r.matricule) },
            { key: 'p', labelKey: 'lc.pRange', render: (r) => h('span', { class: 'mono' }, `${r.from} → ${r.to}`) },
            { key: 'd', labelKey: 'li.days', render: (r) => String(r.days) },
            {
              key: 'cmp', labelKey: 'li.compare',
              render: (r) => h('a', { class: 'btn btn-ghost', href: `#/time/results/${r.employeeId}/${r.from}` }, t('li.compare')),
            },
          ],
          rows: i.pending,
        }));
        wrap.appendChild(pendCard);
      }
      zone.replaceChildren(wrap);
    } catch (e) { zone.replaceChildren(stateForError(e as ApiError, () => void load())); }
  }
  form.addEventListener('submit', (ev) => { ev.preventDefault(); void load(); });
  await load();
  return root;
}

// ---------------------------------------------------------------------------
// Rapports congés : agrégats bornés aux portées — jamais un motif médical
// ---------------------------------------------------------------------------

export async function leaveReportsPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('lrp.title')));
  root.appendChild(h('p', { class: 'section-note' }, t('lrp.hint')));
  const today = new Date();
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const from = field('lc.from', { type: 'date', required: true });
  const to = field('lc.to', { type: 'date', required: true });
  from.input.value = `${today.getUTCFullYear()}-01-01`;
  to.input.value = iso(today);
  const go = button(t('app.search'), null, { variant: 'primary', type: 'submit' });
  const form = h('form', { class: 'filters' }, from.wrap, to.wrap, go) as HTMLFormElement;
  root.appendChild(h('div', { class: 'glass card' }, form));
  const zone = h('div', {});
  root.appendChild(zone);

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const out = await session.api.call<LeaveReportOut>('leaveReports', {
        query: { from: from.input.value, to: to.input.value },
      });
      const r = out.report;
      const wrap = h('div', {});
      const balCard = h('div', { class: 'glass card' }, h('h3', { class: 'section-title' }, t('lrp.balances')));
      if (r.balances.length === 0) balCard.appendChild(h('p', { class: 'section-note' }, t('li.none')));
      for (const b of r.balances) {
        balCard.appendChild(kv([
          [t('lrp.unit'), tk('lv.unit', b.unit)],
          [t('lrp.accrued'), q3(b.accrued)],
          [t('lrp.reserved'), q3(b.reserved)],
          [t('lrp.consumed'), q3(b.consumed)],
          [t('lrp.expired'), q3(b.expired)],
          [t('lrp.available'), q3(b.available)],
        ]));
      }
      balCard.appendChild(kv([
        [t('lrp.utilization'), r.utilization === null ? '—' : `${Math.round(r.utilization * 1000) / 10} %`],
        [t('lrp.avgDelay'), r.avgProcessingHours === null ? '—' : `${r.avgProcessingHours} h`],
        [t('lrp.retro'), String(r.retroRequests)],
        [t('lrp.failed'), String(r.failedApplications)],
        [t('lrp.carried'), q3(r.carriedInExposure)],
      ]));
      wrap.appendChild(balCard);
      if (r.requests.length > 0) {
        const funCard = h('div', { class: 'glass card' }, h('h3', { class: 'section-title' }, t('lrp.funnel')));
        funCard.appendChild(kv(r.requests.map((f) => [tk('lr.st', f.status), String(f.count)] as [string, string])));
        wrap.appendChild(funCard);
      }
      if (r.byCategory.length > 0) {
        const catCard = h('div', { class: 'glass card' }, h('h3', { class: 'section-title' }, t('lrp.byCategory')));
        catCard.appendChild(dataTable<LeaveReportOut['report']['byCategory'][number]>({
          columns: [
            { key: 'c', labelKey: 'lrp.category', render: (x) => tk('lc.cat', x.category) },
            { key: 'd', labelKey: 'li.days', render: (x) => q3(x.days) },
            { key: 'h', labelKey: 'lrp.hours', render: (x) => q3(x.hours) },
            { key: 'n', labelKey: 'lrp.absences', render: (x) => String(x.absences) },
          ],
          rows: r.byCategory,
        }));
        wrap.appendChild(catCard);
      }
      if (r.byUnit.length > 0) {
        const unitCard = h('div', { class: 'glass card' }, h('h3', { class: 'section-title' }, t('lrp.byUnit')));
        unitCard.appendChild(dataTable<LeaveReportOut['report']['byUnit'][number]>({
          columns: [
            { key: 'u', labelKey: 'lrp.unitOrg', render: (x) => x.code ?? t('lrp.noUnit') },
            { key: 'd', labelKey: 'li.days', render: (x) => q3(x.days) },
          ],
          rows: r.byUnit,
        }));
        wrap.appendChild(unitCard);
      }
      wrap.appendChild(h('p', { class: 'section-note' }, t('lrp.privacyNote')));
      zone.replaceChildren(wrap);
    } catch (e) { zone.replaceChildren(stateForError(e as ApiError, () => void load())); }
  }
  form.addEventListener('submit', (ev) => { ev.preventDefault(); void load(); });
  await load();
  return root;
}
