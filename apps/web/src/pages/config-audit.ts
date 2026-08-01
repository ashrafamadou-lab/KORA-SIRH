/**
 * Config Center (E4) et Audit (E6) via PWA — consultation selon permissions.
 * L'audit reste 100 % lecture ; l'export est un téléchargement AUTHENTIFIÉ direct
 * (aucun passage par un cache).
 */
import { h } from '../core/dom.ts';
import { t, type MessageKey } from '../core/i18n.ts';
import { fmtDate, fmtDateTime, toIsoDate } from '../core/format.ts';
import type { Session } from '../core/session.ts';
import { ApiError, type AuditItem } from '../core/api.ts';
import { button, dataTable, drawer, field, kv, pageTitle, statusBadge, stateForError, states, toast } from '../ui/kit.ts';

// ---------------------------------------------------------------------------
// Config Center
// ---------------------------------------------------------------------------

const CFG_STATUS_KEY: Record<string, MessageKey> = {
  draft: 'config.status.draft', submitted: 'config.status.submitted', approved: 'config.status.approved',
  active: 'config.status.active', scheduled: 'config.status.scheduled', superseded: 'config.status.superseded',
  rejected: 'config.status.rejected', retired: 'config.status.retired',
};

interface HistoryRow {
  id: string; status: string; value: unknown; scope: string;
  effectiveFrom: string | null; effectiveTo: string | null;
}

export function configPage(session: Session): HTMLElement {
  const root = h('div', {});
  root.appendChild(pageTitle(t('config.title')));
  root.appendChild(h('p', { class: 'section-note' }, t('config.hint')));

  const keyField = field('config.key', { placeholder: 'social.cnss.taux_salarial' });
  const dateInput = h('input', { type: 'date', value: toIsoDate(new Date()), 'aria-label': t('config.resolveDate') }) as HTMLInputElement;
  const resolveBtn = button(t('config.resolve'), () => void resolve(), { variant: 'primary' });
  root.appendChild(h('div', { class: 'filters' },
    keyField.wrap,
    h('div', { class: 'field' }, h('label', {}, t('config.resolveDate')), dateInput),
    resolveBtn,
  ));
  const result = h('div', {});
  const history = h('div', {});
  history.style.marginTop = '16px';
  root.appendChild(result);
  root.appendChild(history);

  async function resolve(): Promise<void> {
    const key = keyField.input.value.trim();
    keyField.setError(key ? null : t('form.required'));
    if (!key) return;
    result.replaceChildren(states.loading());
    history.replaceChildren();
    try {
      const res = await session.api.call<{ value: unknown } | null>('configResolve', {
        query: { key, date: dateInput.value || toIsoDate(new Date()) },
      });
      const box = h('div', { class: 'glass card' });
      box.appendChild(h('h2', {}, t('config.value')));
      if (res === null || res === undefined) {
        box.appendChild(h('p', { class: 'section-note' }, t('config.noValue')));
      } else {
        box.appendChild(h('pre', { class: 'mono' }, JSON.stringify(res, null, 2)));
      }
      result.replaceChildren(box);
      const rows = await session.api.call<HistoryRow[]>('configHistory', { query: { key } });
      const hbox = h('div', { class: 'glass card' });
      hbox.appendChild(h('h2', {}, t('config.history')));
      hbox.appendChild(rows.length === 0 ? states.empty() : dataTable<HistoryRow>({
        columns: [
          { key: 'scope', labelKey: 'config.version', render: (r) => h('span', { class: 'mono' }, r.scope) },
          {
            key: 'status', labelKey: 'emp.status',
            render: (r) => { const k = CFG_STATUS_KEY[r.status]; return statusBadge(r.status, k ? t(k) : r.status); },
          },
          {
            key: 'window', labelKey: 'config.effectiveFrom',
            render: (r) => `${fmtDate(r.effectiveFrom)} ${r.effectiveTo ? `${t('config.effectiveTo')} ${fmtDate(r.effectiveTo)}` : ''}`,
          },
          { key: 'value', labelKey: 'config.value', render: (r) => h('span', { class: 'mono' }, JSON.stringify(r.value)) },
        ],
        rows,
      }));
      history.replaceChildren(hbox);
    } catch (e) {
      result.replaceChildren(stateForError(e as ApiError, () => void resolve()));
    }
  }

  return root;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const RESULT_KEY: Record<string, MessageKey> = {
  success: 'audit.result.success', denied: 'audit.result.denied', failure: 'audit.result.failure',
};

export async function auditPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  const canExport = session.hasPermission('audit.export');
  const exportCsv = canExport ? button(t('audit.exportCsv'), () => void download('auditExportCsv', 'audit.csv'), { small: true }) : null;
  const exportJson = canExport ? button(t('audit.exportJson'), () => void download('auditExportJson', 'audit.json'), { small: true, variant: 'ghost' }) : null;
  root.appendChild(pageTitle(t('audit.title'), exportCsv, exportJson));
  root.appendChild(h('p', { class: 'section-note' }, t('audit.hint')));

  const moduleField = field('audit.module', { placeholder: 'hr, org, auth…' });
  const actionField = field('audit.action', { placeholder: 'hr_status_changed…' });
  const applyBtn = button(t('app.search'), () => {
    cursor = null;
    items = [];
    void load();
  }, { variant: 'primary' });
  root.appendChild(h('div', { class: 'filters' }, moduleField.wrap, actionField.wrap, applyBtn));

  const zone = h('div', {});
  root.appendChild(zone);
  const moreWrap = h('div', { class: 'table-footer' });
  root.appendChild(moreWrap);

  let items: AuditItem[] = [];
  let cursor: string | null = null;

  async function load(): Promise<void> {
    if (items.length === 0) zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: AuditItem[]; nextCursor: string | null }>('auditEvents', {
        query: {
          module: moduleField.input.value.trim() || undefined,
          action: actionField.input.value.trim() || undefined,
          cursor: cursor ?? undefined,
          limit: 50,
        },
      });
      items = [...items, ...res.items];
      cursor = res.nextCursor;
      render();
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }

  function render(): void {
    if (items.length === 0) {
      zone.replaceChildren(states.empty('state.emptyFiltered'));
      moreWrap.replaceChildren();
      return;
    }
    zone.replaceChildren(dataTable<AuditItem>({
      columns: [
        { key: 'when', labelKey: 'audit.when', render: (r) => fmtDateTime(r.occurredAt) },
        { key: 'module', labelKey: 'audit.module', render: (r) => h('span', { class: 'mono' }, r.module) },
        { key: 'action', labelKey: 'audit.action', render: (r) => h('span', { class: 'mono' }, r.action) },
        { key: 'record', labelKey: 'audit.record', render: (r) => h('span', { class: 'mono section-note' }, `${r.recordType ?? ''} ${r.recordId ?? ''}`.trim() || t('app.none')) },
        {
          key: 'result', labelKey: 'audit.result',
          render: (r) => {
            if (!r.result) return t('app.none');
            const k = RESULT_KEY[r.result];
            return statusBadge(r.result, k ? t(k) : r.result);
          },
        },
      ],
      rows: items,
      onRowClick: (r) => void openDetail(r.id),
    }));
    moreWrap.replaceChildren(cursor ? button(t('audit.loadMore'), () => void load()) : h('span', {}));
  }

  async function openDetail(id: string): Promise<void> {
    try {
      const ev = await session.api.call<AuditItem & { oldValue: unknown; newValue: unknown; reason: string | null }>('auditEvent', { params: { id } });
      drawer(t('audit.detail'),
        kv([
          [t('audit.when'), fmtDateTime(ev.occurredAt)],
          [t('audit.module'), h('span', { class: 'mono' }, ev.module)],
          [t('audit.action'), h('span', { class: 'mono' }, ev.action)],
          [t('audit.reason'), ev.reason ?? t('app.none')],
        ]),
        ev.oldValue !== null && ev.oldValue !== undefined
          ? h('div', {}, h('h2', {}, t('audit.oldValue')), h('pre', { class: 'mono' }, JSON.stringify(ev.oldValue, null, 2)))
          : null,
        ev.newValue !== null && ev.newValue !== undefined
          ? h('div', {}, h('h2', {}, t('audit.newValue')), h('pre', { class: 'mono' }, JSON.stringify(ev.newValue, null, 2)))
          : null,
      );
    } catch (e) {
      toast((e as ApiError).kind === 'forbidden' ? t('state.forbiddenBody') : t('state.error'), 'err');
    }
  }

  async function download(key: 'auditExportCsv' | 'auditExportJson', filename: string): Promise<void> {
    try {
      const { blob } = await session.api.download(key, {
        module: moduleField.input.value.trim() || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      toast((e as ApiError).kind === 'forbidden' ? t('state.forbiddenBody') : t('state.error'), 'err');
    }
  }

  await load();
  return root;
}
