/**
 * Organisation (E8 via PWA) — consultation des référentiels et ORGANIGRAMME À UNE
 * DATE (une réorganisation future ne change pas la lecture passée).
 */
import { h } from '../core/dom.ts';
import { t, getLocale, type MessageKey } from '../core/i18n.ts';
import { toIsoDate } from '../core/format.ts';
import type { Session } from '../core/session.ts';
import type { ApiError, OrgChartNode, OrgItem, OrgUnitItem } from '../core/api.ts';
import { button, dataTable, pageTitle, statusBadge, stateForError, states } from '../ui/kit.ts';

const ORG_STATUS_KEY: Record<string, MessageKey> = {
  draft: 'org.status.draft', active: 'org.status.active', inactive: 'org.status.inactive', archived: 'org.status.archived',
};
const UNIT_TYPE_KEY: Record<string, MessageKey> = {
  direction: 'org.unitType.direction', department: 'org.unitType.department',
  service: 'org.unitType.service', team: 'org.unitType.team',
};

function orgLabel(item: { labelFr: string; labelEn: string }): string {
  return getLocale() === 'en' ? item.labelEn : item.labelFr;
}
function orgStatus(status: string): HTMLElement {
  const key = ORG_STATUS_KEY[status];
  return statusBadge(status, key ? t(key) : status);
}

export async function orgListPage(
  session: Session,
  entity: 'companies' | 'units' | 'positions',
): Promise<HTMLElement> {
  const root = h('div', {});
  const titleKey: MessageKey = entity === 'companies' ? 'org.companies' : entity === 'units' ? 'org.units' : 'org.positions';
  root.appendChild(pageTitle(t(titleKey)));
  const zone = h('div', {});
  root.appendChild(zone);
  zone.appendChild(states.loading());
  try {
    if (entity === 'units') {
      const rows = await session.api.call<OrgUnitItem[]>('orgUnits', { query: { limit: 200 } });
      zone.replaceChildren(rows.length === 0 ? states.empty() : dataTable<OrgUnitItem>({
        columns: [
          { key: 'code', labelKey: 'org.code', render: (r) => h('span', { class: 'mono' }, r.code) },
          { key: 'label', labelKey: 'org.label', render: (r) => orgLabel(r) },
          { key: 'type', labelKey: 'org.type', render: (r) => { const k = UNIT_TYPE_KEY[r.unitType]; return k ? t(k) : r.unitType; } },
          { key: 'status', labelKey: 'emp.status', render: (r) => orgStatus(r.status) },
        ],
        rows,
      }));
      return root;
    }
    const contractKey = entity === 'companies' ? 'orgCompanies' : 'orgPositions';
    const rows = await session.api.call<OrgItem[]>(contractKey, { query: { limit: 200 } });
    zone.replaceChildren(rows.length === 0 ? states.empty() : dataTable<OrgItem>({
      columns: [
        { key: 'code', labelKey: 'org.code', render: (r) => h('span', { class: 'mono' }, r.code) },
        { key: 'label', labelKey: 'org.label', render: (r) => orgLabel(r) },
        { key: 'status', labelKey: 'emp.status', render: (r) => orgStatus(r.status) },
      ],
      rows,
    }));
  } catch (e) {
    zone.replaceChildren(stateForError(e as ApiError));
  }
  return root;
}

export async function orgChartPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('org.chartTitle')));
  root.appendChild(h('p', { class: 'section-note' }, t('org.chartHint')));

  const dateInput = h('input', { type: 'date', value: toIsoDate(new Date()), 'aria-label': t('org.chartAtDate') }) as HTMLInputElement;
  const applyBtn = button(t('app.search'), () => void load(), { variant: 'primary' });
  const filters = h('div', { class: 'filters' },
    h('div', { class: 'field' }, h('label', {}, t('org.chartAtDate')), dateInput),
    applyBtn,
  );
  root.appendChild(filters);
  const zone = h('div', { class: 'glass card orgchart' });
  root.appendChild(zone);

  function renderNode(node: OrgChartNode): HTMLElement {
    const details = h('details', { open: '' }) as HTMLDetailsElement;
    const typeKey = UNIT_TYPE_KEY[node.unitType];
    details.appendChild(h('summary', {},
      h('span', { class: 'code' }, node.code),
      h('strong', {}, orgLabel(node)),
      h('span', { class: 'section-note' }, typeKey ? t(typeKey) : node.unitType),
      orgStatus(node.status),
    ));
    for (const child of node.children) details.appendChild(renderNode(child));
    return details;
  }

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ date: string; tree: OrgChartNode[] }>('orgChart', {
        query: { date: dateInput.value || toIsoDate(new Date()) },
      });
      if (res.tree.length === 0) {
        zone.replaceChildren(states.empty());
        return;
      }
      zone.replaceChildren(...res.tree.map(renderNode));
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }

  await load();
  return root;
}
