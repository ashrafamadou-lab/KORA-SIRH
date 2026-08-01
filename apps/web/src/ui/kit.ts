/**
 * Socle de composants KORA (E7) — accessibles, i18n, sans chaîne en dur.
 * Tout texte vient de t() ; tout rendu passe par h()/textContent (anti-XSS).
 */
import { h, clear, type Child } from '../core/dom.ts';
import { t, type MessageKey } from '../core/i18n.ts';

// ---------------------------------------------------------------------------
// Icônes internes (SVG géométriques dessinés par code — aucune ressource externe)
// ---------------------------------------------------------------------------

const ICON_PATHS: Record<string, string> = {
  home: 'M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z',
  tasks: 'M5 5h9v2H5zm0 6h14v2H5zm0 6h11v2H5zM17 4l2 2 3-3',
  bell: 'M12 3a5 5 0 0 0-5 5v3l-2 4h14l-2-4V8a5 5 0 0 0-5-5zm-2 14a2 2 0 0 0 4 0',
  people: 'M8 8a3 3 0 1 1 6 0 3 3 0 0 1-6 0zm-4 12a7 7 0 0 1 14 0zM17 6a2.4 2.4 0 1 1 0 5',
  org: 'M10 3h4v5h-4zM4 15h4v5H4zm12 0h4v5h-4zM12 8v4M6 15v-3h12v3',
  chart: 'M4 20V6m0 14h16M8 16v-5m4 5V8m4 8v-3',
  building: 'M5 21V4h9v17M9 8h1m-1 4h1m3-4h1m-1 4h1M14 21v-9h5v9',
  seat: 'M7 4h10v7H7zm-2 9h14v3H5zm2 3v4m10-4v4',
  shield: 'M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z',
  sliders: 'M5 7h14M5 12h14M5 17h14M9 5v4m6 1v4m-3 3v4',
  scroll: 'M7 4h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6m4 4h6m-6 4h6',
  devices: 'M4 6h12v9H4zM2 18h16M20 9h2v9h-5',
  key: 'M14 10a4 4 0 1 0-4 4l1 1h2v2h2v2h3v-3l-5-5',
  logout: 'M9 4h7v16H9m3-8H3m3-3-3 3 3 3',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm-9 9h18M12 3c3 3 3 15 0 18-3-3-3-15 0-18z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  user: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm-8 17a8 8 0 0 1 16 0',
};

export function icon(name: string): HTMLElement {
  const span = h('span', { class: 'icon', 'aria-hidden': 'true' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[name] ?? ICON_PATHS['home']!);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  span.appendChild(svg);
  return span;
}

// ---------------------------------------------------------------------------
// Boutons — anti double-soumission intégrée
// ---------------------------------------------------------------------------

export interface ButtonOpts {
  variant?: 'primary' | 'default' | 'danger' | 'ghost';
  small?: boolean;
  type?: 'button' | 'submit';
  ariaLabel?: string;
}

export function button(label: string, onClick: (() => void | Promise<void>) | null, opts: ButtonOpts = {}): HTMLButtonElement {
  const cls = ['btn'];
  if (opts.variant === 'primary') cls.push('btn-primary');
  if (opts.variant === 'danger') cls.push('btn-danger');
  if (opts.variant === 'ghost') cls.push('btn-ghost');
  if (opts.small) cls.push('btn-sm');
  const el = h('button', { class: cls.join(' '), type: opts.type ?? 'button', 'aria-label': opts.ariaLabel }, label) as HTMLButtonElement;
  if (onClick) {
    el.addEventListener('click', () => void guardedRun(el, onClick));
  }
  return el;
}

/** Exécute une action en désactivant le déclencheur : une action = un envoi. */
export async function guardedRun(el: HTMLButtonElement, fn: () => void | Promise<void>): Promise<void> {
  if (el.disabled) return;
  el.disabled = true;
  const prev = el.textContent;
  try {
    await fn();
  } finally {
    el.disabled = false;
    if (el.textContent !== prev) el.textContent = prev;
  }
}

/** Soumission de formulaire protégée contre le double envoi. */
export function guardedSubmit(form: HTMLFormElement, submitBtn: HTMLButtonElement, fn: () => Promise<void>): void {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    const prev = submitBtn.textContent;
    submitBtn.textContent = t('form.submitting');
    void (async () => {
      try {
        await fn();
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = prev;
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// Champs de formulaire accessibles (label TOUJOURS associé)
// ---------------------------------------------------------------------------

let fieldSeq = 0;

export interface FieldOpts {
  type?: string;
  value?: string;
  required?: boolean;
  placeholder?: string;
  hintKey?: MessageKey;
  autocomplete?: string;
  name?: string;
}

export function field(labelKey: MessageKey, opts: FieldOpts = {}): { wrap: HTMLElement; input: HTMLInputElement; setError(msg: string | null): void } {
  const id = `f-${++fieldSeq}`;
  const input = h('input', {
    id,
    type: opts.type ?? 'text',
    value: opts.value,
    required: opts.required,
    placeholder: opts.placeholder,
    autocomplete: opts.autocomplete,
    name: opts.name,
  }) as HTMLInputElement;
  const errorEl = h('span', { class: 'error', role: 'alert' });
  errorEl.style.display = 'none';
  const wrap = h('div', { class: 'field' },
    h('label', { for: id }, t(labelKey)),
    input,
    opts.hintKey ? h('span', { class: 'hint' }, t(opts.hintKey)) : null,
    errorEl,
  );
  return {
    wrap,
    input,
    setError(msg) {
      if (msg === null) {
        errorEl.style.display = 'none';
        errorEl.textContent = '';
      } else {
        errorEl.style.display = '';
        errorEl.textContent = msg;
      }
    },
  };
}

export function selectField(labelKey: MessageKey, options: Array<{ value: string; label: string }>, value?: string): { wrap: HTMLElement; select: HTMLSelectElement } {
  const id = `f-${++fieldSeq}`;
  const select = h('select', { id }) as HTMLSelectElement;
  for (const o of options) {
    const opt = h('option', { value: o.value }, o.label) as HTMLOptionElement;
    if (o.value === value) opt.selected = true;
    select.appendChild(opt);
  }
  const wrap = h('div', { class: 'field' }, h('label', { for: id }, t(labelKey)), select);
  return { wrap, select };
}

// ---------------------------------------------------------------------------
// Badges de statut (texte + point de couleur — jamais la couleur seule)
// ---------------------------------------------------------------------------

const STATUS_TONE: Record<string, string> = {
  active: 'badge-ok', approved: 'badge-ok', success: 'badge-ok', applied: 'badge-ok', sent: 'badge-ok',
  pending: 'badge-info', draft: 'badge-info', pre_hire: 'badge-info', submitted: 'badge-info', scheduled: 'badge-info',
  suspended: 'badge-warn', on_leave: 'badge-warn', returned: 'badge-warn', inactive: 'badge-warn', superseded: 'badge-warn',
  terminated: 'badge-danger', rejected: 'badge-danger', denied: 'badge-danger', failure: 'badge-danger',
  cancelled: 'badge-danger', expired: 'badge-danger', archived: 'badge-danger', retired: 'badge-danger', conflict: 'badge-danger',
};

export function statusBadge(status: string, label: string): HTMLElement {
  return h('span', { class: `badge ${STATUS_TONE[status] ?? ''}`.trim(), 'data-status': status }, label);
}

export function countBadge(n: number): HTMLElement {
  return h('span', { class: 'badge badge-count', 'aria-label': String(n) }, String(n));
}

// ---------------------------------------------------------------------------
// États d'écran
// ---------------------------------------------------------------------------

function stateBlock(iconChar: string, titleKey: MessageKey, bodyKey: MessageKey | null, extra?: Child): HTMLElement {
  return h('div', { class: 'state glass', role: 'status' },
    h('div', { class: 'state-icon', 'aria-hidden': 'true' }, iconChar),
    h('h2', {}, t(titleKey)),
    bodyKey ? h('p', {}, t(bodyKey)) : null,
    extra,
  );
}

export const states = {
  loading(): HTMLElement {
    const sk = h('div', { class: 'glass card', 'aria-busy': 'true', role: 'status', 'aria-label': t('app.loading') });
    for (const w of ['62%', '94%', '78%', '86%']) {
      const line = h('div', { class: 'skeleton' });
      line.style.width = w;
      line.style.height = '14px';
      line.style.margin = '12px 0';
      sk.appendChild(line);
    }
    return sk;
  },
  empty(bodyKey: MessageKey = 'state.empty'): HTMLElement {
    return stateBlock('◌', 'state.empty', null, h('p', {}, t(bodyKey)));
  },
  forbidden(): HTMLElement {
    return stateBlock('⛊', 'state.forbidden', 'state.forbiddenBody');
  },
  notFound(): HTMLElement {
    return stateBlock('∅', 'state.notFound', 'state.notFoundBody');
  },
  offline(retry?: () => void): HTMLElement {
    return stateBlock('⇅', 'state.offline', 'state.offlineBody',
      retry ? button(t('app.retry'), retry, { variant: 'primary' }) : undefined);
  },
  unavailable(retry?: () => void): HTMLElement {
    return stateBlock('…', 'state.unavailable', 'state.unavailableBody',
      retry ? button(t('app.retry'), retry, { variant: 'primary' }) : undefined);
  },
  conflict(): HTMLElement {
    return stateBlock('⇄', 'state.conflict', 'state.conflictBody');
  },
  locked(seconds: number | null): HTMLElement {
    const blockEl = stateBlock('🔒', 'state.locked', 'state.lockedBody');
    if (seconds !== null) blockEl.appendChild(h('p', { class: 'mono' }, t('state.rateLimitedBody', { seconds })));
    return blockEl;
  },
  rateLimited(seconds: number | null): HTMLElement {
    return stateBlock('⏳', 'state.rateLimited', null,
      h('p', {}, t('state.rateLimitedBody', { seconds: seconds ?? 60 })));
  },
  error(retry?: () => void): HTMLElement {
    return stateBlock('!', 'state.error', 'state.loadError',
      retry ? button(t('app.retry'), retry, { variant: 'primary' }) : undefined);
  },
};

/** Traduit une ApiError en état d'écran approprié. */
export function stateForError(e: { kind?: string; retryAfterSeconds?: number | null }, retry?: () => void): HTMLElement {
  switch (e.kind) {
    case 'forbidden': return states.forbidden();
    case 'not_found': return states.notFound();
    case 'offline': return states.offline(retry);
    case 'unavailable': return states.unavailable(retry);
    case 'conflict': return states.conflict();
    case 'locked': return states.locked(e.retryAfterSeconds ?? null);
    case 'rate_limited': return states.rateLimited(e.retryAfterSeconds ?? null);
    default: return states.error(retry);
  }
}

// ---------------------------------------------------------------------------
// Donnée sensible masquée (affichage) — le masquage RÉEL vient du serveur
// ---------------------------------------------------------------------------

export function maskedValue(value: string | null | undefined): HTMLElement {
  if (value === null || value === undefined || value === '') {
    return h('span', { class: 'masked', title: t('app.maskedHint') }, '•••');
  }
  return h('span', {}, value);
}

/** Garde d'affichage : rend children si permission, sinon rien (ou un masque). */
export function permissionGuard(has: boolean, render: () => Child, fallback?: () => Child): Child {
  if (has) return render();
  return fallback ? fallback() : null;
}

// ---------------------------------------------------------------------------
// Modal de confirmation — TOUTE action sensible passe ici
// ---------------------------------------------------------------------------

export function confirmModal(message: string, opts: { danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') done(false);
    };
    const ok = button(t('app.confirm'), () => done(true), { variant: opts.danger ? 'danger' : 'primary' });
    const cancel = button(t('app.cancel'), () => done(false));
    const modal = h('div', { class: 'modal glass glass-strong', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': t('app.confirm') },
      h('p', {}, message),
      h('div', { class: 'modal-actions' }, cancel, ok),
    );
    const overlay = h('div', { class: 'overlay' }, modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    ok.focus();
  });
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastRoot: HTMLElement | null = null;

export function toast(message: string, kind: 'ok' | 'err' = 'ok'): void {
  if (!toastRoot || !document.body.contains(toastRoot)) {
    toastRoot = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastRoot);
  }
  const el = h('div', { class: `toast glass ${kind === 'ok' ? 'toast-ok' : 'toast-err'}` }, message);
  toastRoot.appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

// ---------------------------------------------------------------------------
// Tableau générique — pagination serveur, tri, vue cartes mobile
// ---------------------------------------------------------------------------

export interface Column<T> {
  key: string;
  labelKey: MessageKey;
  render(row: T): Child;
  sortable?: boolean;
}

export interface TableOpts<T> {
  columns: Array<Column<T>>;
  rows: T[];
  onRowClick?: (row: T) => void;
  page?: number;
  hasMore?: boolean;
  onPage?: (page: number) => void;
  sort?: { key: string; dir: 'asc' | 'desc' };
  onSort?: (key: string) => void;
  responsive?: boolean;
}

export function dataTable<T>(opts: TableOpts<T>): HTMLElement {
  const thead = h('thead', {},
    h('tr', {}, ...opts.columns.map((c) => {
      const label = t(c.labelKey);
      if (!c.sortable || !opts.onSort) return h('th', { scope: 'col' }, label);
      const arrow = opts.sort?.key === c.key ? (opts.sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
      return h('th', { scope: 'col' },
        h('button', { type: 'button', 'aria-label': t('table.sortBy', { column: label }), onclick: () => opts.onSort!(c.key) }, `${label}${arrow}`));
    })),
  );
  const tbody = h('tbody', {});
  for (const row of opts.rows) {
    const tr = h('tr', { class: opts.onRowClick ? 'clickable' : undefined });
    if (opts.onRowClick) {
      tr.setAttribute('tabindex', '0');
      tr.addEventListener('click', () => opts.onRowClick!(row));
      tr.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') opts.onRowClick!(row);
      });
    }
    for (const c of opts.columns) {
      const td = h('td', { 'data-label': t(c.labelKey) });
      const content = c.render(row);
      if (content !== null && content !== undefined && content !== false) {
        td.appendChild(typeof content === 'string' ? document.createTextNode(content) : content);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  const table = h('table', { class: `k-table${opts.responsive === false ? '' : ' responsive'}` }, thead, tbody);
  const wrap = h('div', { class: 'table-wrap glass' }, table);
  if (opts.onPage !== undefined && opts.page !== undefined) {
    const page = opts.page;
    const footer = h('div', { class: 'table-footer' },
      h('span', {}, t('table.rows', { count: opts.rows.length })),
      h('span', { class: 'spacer' }),
      button(t('table.prev'), page > 1 ? () => opts.onPage!(page - 1) : null, { small: true }),
      h('span', {}, t('table.page', { page })),
      button(t('table.next'), opts.hasMore ? () => opts.onPage!(page + 1) : null, { small: true }),
    );
    const prevBtn = footer.querySelectorAll('button')[0] as HTMLButtonElement;
    const nextBtn = footer.querySelectorAll('button')[1] as HTMLButtonElement;
    if (page <= 1) prevBtn.disabled = true;
    if (!opts.hasMore) nextBtn.disabled = true;
    wrap.appendChild(footer);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Divers structurels
// ---------------------------------------------------------------------------

export function pageTitle(title: string, ...actions: Child[]): HTMLElement {
  return h('div', { class: 'page-title' }, h('h1', {}, title), h('span', { class: 'spacer' }), ...actions);
}

export function statCard(labelKey: MessageKey, value: string, linkRoute?: string, linkKey?: MessageKey): HTMLElement {
  return h('div', { class: 'glass card' },
    h('div', { class: 'stat-value' }, value),
    h('div', { class: 'stat-label' }, t(labelKey)),
    linkRoute && linkKey ? h('a', { class: 'stat-link', href: `#${linkRoute}` }, t(linkKey)) : null,
  );
}

export function barList(entries: Array<{ label: string; count: number }>): HTMLElement {
  const max = Math.max(1, ...entries.map((e) => e.count));
  const root = h('div', {});
  for (const e of entries) {
    const fill = h('div', { class: 'bar-fill' });
    fill.style.width = `${Math.round((e.count / max) * 100)}%`;
    root.appendChild(h('div', { class: 'bar-row' },
      h('span', {}, e.label),
      h('div', { class: 'bar-track', 'aria-hidden': 'true' }, fill),
      h('span', { class: 'mono' }, String(e.count)),
    ));
  }
  return root;
}

export function tabs(items: Array<{ key: string; label: string }>, active: string, onSelect: (key: string) => void): HTMLElement {
  return h('div', { class: 'tabs', role: 'tablist' },
    ...items.map((it) => h('button', {
      class: 'tab', role: 'tab', 'aria-selected': it.key === active ? 'true' : 'false',
      onclick: () => onSelect(it.key),
    }, it.label)),
  );
}

export function kv(entries: Array<[string, Child]>): HTMLElement {
  const dl = h('dl', { class: 'kv' });
  for (const [label, value] of entries) {
    dl.appendChild(h('dt', {}, label));
    const dd = h('dd', {});
    if (value !== null && value !== undefined && value !== false) {
      dd.appendChild(typeof value === 'string' ? document.createTextNode(value) : value);
    } else {
      dd.textContent = t('app.none');
    }
    dl.appendChild(dd);
  }
  return dl;
}

export function drawer(title: string, ...children: Child[]): { el: HTMLElement; close(): void } {
  const closeBtn = button(t('app.close'), () => api.close(), { small: true, ariaLabel: t('app.close') });
  const el = h('aside', { class: 'drawer glass glass-strong', role: 'dialog', 'aria-modal': 'false', 'aria-label': title },
    h('div', { class: 'page-title' }, h('h1', {}, title), h('span', { class: 'spacer' }), closeBtn),
    ...children,
  );
  const api = {
    el,
    close() {
      el.remove();
    },
  };
  document.body.appendChild(el);
  return api;
}

export { clear };
