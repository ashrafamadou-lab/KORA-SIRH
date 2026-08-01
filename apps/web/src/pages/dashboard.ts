/**
 * Tableau de bord (E7) — construit UNIQUEMENT sur les données réellement servies :
 * salariés actifs (page bornée à 200, annoncé honnêtement), répartitions calculées
 * sur l'échantillon visible du périmètre, tâches en attente, notifications non lues,
 * sessions actives, événements administratifs récents si l'audit est consultable.
 * Aucune donnée de présence, congés, paie ou recrutement — ces modules n'existent pas.
 */
import { h } from '../core/dom.ts';
import { t } from '../core/i18n.ts';
import { fmtDateTime } from '../core/format.ts';
import type { Session } from '../core/session.ts';
import type { ApiError, AuditItem, EmployeeListItem, NotificationItem, OrgItem, OrgUnitItem, WorkflowListItem, ActiveSession } from '../core/api.ts';
import { barList, pageTitle, statCard, stateForError, states } from '../ui/kit.ts';

export async function dashboardPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  const me = session.me!;
  root.appendChild(pageTitle(t('dash.title')));
  root.appendChild(h('p', { class: 'section-note' }, t('dash.hello', { name: me.email })));
  const cards = h('div', { class: 'grid-cards' });
  root.appendChild(cards);
  const breakdowns = h('div', { class: 'grid-cards' });
  breakdowns.style.marginTop = '16px';
  root.appendChild(breakdowns);

  const canEmployees = session.hasPermission('employees.view');
  const canWorkflow = session.hasPermission('workflow.view');
  const canAudit = me.permissions.some((p) => p.startsWith('audit.view'));
  const canOrg = session.hasPermission('org.view');

  // Chargements parallèles, chacun avec son propre repli — un échec n'éteint pas tout.
  const [employees, inbox, notifs, sessions] = await Promise.all([
    canEmployees
      ? session.api.call<{ items: EmployeeListItem[] }>('employees', { query: { status: 'active', limit: 200 } }).catch(() => null)
      : Promise.resolve(null),
    canWorkflow
      ? session.api.call<{ items: WorkflowListItem[] }>('workflowInstances', { query: { box: 'inbox' } }).catch(() => null)
      : Promise.resolve(null),
    session.api.call<{ items: NotificationItem[] }>('notifications', { query: { unread: 1, limit: 100 } }).catch(() => null),
    session.api.call<ActiveSession[]>('sessions', {}).catch(() => null),
  ]);

  if (employees) {
    const n = employees.items.length;
    cards.appendChild(statCard('dash.activeEmployees', n >= 200 ? t('dash.capNote') : String(n), '/employees', 'nav.employees'));
  }
  if (inbox) {
    cards.appendChild(statCard('dash.pendingTasks', String(inbox.items.length), '/workflow', 'dash.goInbox'));
  }
  if (notifs) {
    cards.appendChild(statCard('dash.unreadNotifications', String(notifs.items.length), '/notifications', 'nav.notifications'));
  }
  if (sessions) {
    cards.appendChild(statCard('dash.activeSessions', String(sessions.length), '/me/sessions', 'nav.sessions'));
  }

  // Répartitions sur l'échantillon visible (honnêteté du périmètre : annoncée).
  if (employees && employees.items.length > 0 && canOrg) {
    const [companies, units] = await Promise.all([
      session.api.call<OrgItem[]>('orgCompanies', { query: { limit: 200 } }).catch(() => [] as OrgItem[]),
      session.api.call<OrgUnitItem[]>('orgUnits', { query: { limit: 200 } }).catch(() => [] as OrgUnitItem[]),
    ]);
    const companyName = new Map(companies.map((c) => [c.id, c.code]));
    const byCompany = new Map<string, number>();
    for (const e of employees.items) {
      const key = e.employerCompanyId ? companyName.get(e.employerCompanyId) ?? '—' : '—';
      byCompany.set(key, (byCompany.get(key) ?? 0) + 1);
    }
    const companyCard = h('div', { class: 'glass card' },
      h('h2', {}, t('dash.byCompany')),
      barList([...byCompany.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 8)),
      h('p', { class: 'section-note' }, t('dash.sampleNote', { count: employees.items.length })),
    );
    breakdowns.appendChild(companyCard);
    // Répartition par unité : à partir des affectations « à aujourd'hui » servies par
    // /employees?unitId ? — coûteux ; v1 : unités du périmètre listées sans jointure,
    // la répartition fine par unité arrive avec un endpoint d'agrégat dédié.
    if (units.length > 0) {
      const unitCard = h('div', { class: 'glass card' },
        h('h2', {}, t('dash.byUnit')),
        h('p', { class: 'section-note' }, t('app.notImplemented')),
      );
      breakdowns.appendChild(unitCard);
    }
  }

  if (inbox && inbox.items.length === 0) {
    root.appendChild(h('p', { class: 'section-note' }, t('dash.noTask')));
  }

  // Derniers événements administratifs (selon la permission d'audit).
  if (canAudit) {
    try {
      const events = await session.api.call<{ items: AuditItem[] }>('auditEvents', { query: { limit: 8 } });
      const list = h('ul', { class: 'timeline' });
      for (const ev of events.items) {
        list.appendChild(h('li', {},
          h('div', { class: 'when' }, fmtDateTime(ev.occurredAt)),
          h('div', {}, `${ev.module} · ${ev.action}`),
        ));
      }
      const box = h('div', { class: 'glass card' }, h('h2', {}, t('dash.recentAdmin')), events.items.length > 0 ? list : states.empty());
      box.style.marginTop = '16px';
      root.appendChild(box);
    } catch (e) {
      root.appendChild(stateForError(e as ApiError));
    }
  }

  return root;
}
