/**
 * Tâches et demandes (E3 via PWA) — boîte « à traiter » (décidable par MOI, règle
 * serveur identique à decide) et « mes demandes ». Chaque décision exige une
 * CONFIRMATION explicite, est protégée contre la double soumission (bouton verrouillé
 * + idempotencyKey) et gère l'état « déjà traité » (409 stale).
 */
import { h } from '../core/dom.ts';
import { t, type MessageKey } from '../core/i18n.ts';
import { fmtDateTime } from '../core/format.ts';
import type { Session } from '../core/session.ts';
import { ApiError, type WorkflowListItem } from '../core/api.ts';
import { button, confirmModal, dataTable, drawer, pageTitle, statusBadge, stateForError, states, tabs, toast } from '../ui/kit.ts';

const WF_STATUS_KEY: Record<string, MessageKey> = {
  pending: 'wf.status.pending', approved: 'wf.status.approved', rejected: 'wf.status.rejected',
  returned: 'wf.status.returned', cancelled: 'wf.status.cancelled', expired: 'wf.status.expired',
};

function wfStatus(status: string): HTMLElement {
  const key = WF_STATUS_KEY[status];
  return statusBadge(status, key ? t(key) : status);
}

interface InstanceDetail {
  id: string; definitionKey: string; status: string; currentStepIndex: number;
  subjectType: string; subjectId: string; createdBy: string;
  history: Array<{ seq: number; action: string; fromStatus: string; toStatus: string; actorUserId: string | null; comment: string | null; occurredAt: string }>;
}

export async function workflowPage(session: Session, onInboxCount: (n: number) => void): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('wf.title')));
  let box: 'inbox' | 'outbox' = 'inbox';
  const tabBar = h('div', {});
  const zone = h('div', {});
  root.appendChild(tabBar);
  root.appendChild(zone);

  function renderTabs(): void {
    tabBar.replaceChildren(tabs(
      [{ key: 'inbox', label: t('wf.inbox') }, { key: 'outbox', label: t('wf.outbox') }],
      box,
      (key) => {
        box = key as 'inbox' | 'outbox';
        renderTabs();
        void load();
      },
    ));
  }

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: WorkflowListItem[] }>('workflowInstances', { query: { box } });
      if (box === 'inbox') onInboxCount(res.items.length);
      if (res.items.length === 0) {
        zone.replaceChildren(states.empty(box === 'inbox' ? 'wf.emptyInbox' : 'wf.emptyOutbox'));
        return;
      }
      zone.replaceChildren(dataTable<WorkflowListItem>({
        columns: [
          { key: 'def', labelKey: 'wf.subject', render: (r) => h('span', {}, h('span', { class: 'mono' }, r.definitionKey), ` · ${r.subjectType}`) },
          { key: 'step', labelKey: 'wf.step', render: (r) => r.stepName ?? t('app.none') },
          { key: 'status', labelKey: 'emp.status', render: (r) => wfStatus(r.status) },
          { key: 'created', labelKey: 'session.createdAt', render: (r) => fmtDateTime(r.createdAt) },
          { key: 'deadline', labelKey: 'wf.deadline', render: (r) => r.stepDeadline ? fmtDateTime(r.stepDeadline) : t('app.none') },
        ],
        rows: res.items,
        onRowClick: (r) => void openDetail(r),
      }));
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }

  async function openDetail(item: WorkflowListItem): Promise<void> {
    let detail: InstanceDetail;
    try {
      detail = await session.api.call<InstanceDetail>('workflowInstance', { params: { id: item.id } });
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError));
      return;
    }
    const isMine = detail.createdBy === session.me?.userId;
    const actionsRow = h('div', { class: 'modal-actions' });
    const d = drawer(`${detail.definitionKey}`,
      h('p', { class: 'section-note' }, `${t('wf.subject')} : ${detail.subjectType}`),
      h('p', {}, wfStatus(detail.status)),
      h('h2', {}, t('wf.history')),
      historyList(detail),
      actionsRow,
    );

    const decide = (action: 'workflowApprove' | 'workflowReject' | 'workflowReturn' | 'workflowCancel', confirmKey: MessageKey, danger: boolean) =>
      async () => {
        const okConfirm = await confirmModal(t(confirmKey), { danger });
        if (!okConfirm) return;
        try {
          await session.api.call(action, {
            params: { id: detail.id },
            // Idempotence : un double clic/rejeu réseau ne crée jamais deux transitions.
            body: { idempotencyKey: `pwa-${detail.id}-${detail.status}-${action}`, expectedRevision: item.revision },
          });
          toast(t('wf.decided'), 'ok');
          d.close();
          await load();
        } catch (e) {
          const err = e as ApiError;
          if (err.kind === 'conflict') {
            toast(t('wf.staleBody'), 'err');
            d.close();
            await load();
          } else if (err.kind === 'forbidden') {
            toast(t('state.forbiddenBody'), 'err');
          } else {
            toast(t('state.error'), 'err');
          }
        }
      };

    if (detail.status === 'pending' && !isMine && session.hasPermission('workflow.act')) {
      actionsRow.appendChild(button(t('wf.approve'), decide('workflowApprove', 'wf.approveConfirm', false), { variant: 'primary' }));
      actionsRow.appendChild(button(t('wf.reject'), decide('workflowReject', 'wf.rejectConfirm', true), { variant: 'danger' }));
      actionsRow.appendChild(button(t('wf.return'), decide('workflowReturn', 'wf.returnConfirm', false)));
    }
    if (detail.status === 'pending' && isMine) {
      actionsRow.appendChild(button(t('wf.cancel'), decide('workflowCancel', 'wf.cancelConfirm', true), { variant: 'danger' }));
    }
  }

  function historyList(detail: InstanceDetail): HTMLElement {
    const list = h('ul', { class: 'timeline' });
    for (const tr of detail.history) {
      list.appendChild(h('li', {},
        h('div', { class: 'when' }, fmtDateTime(tr.occurredAt)),
        h('div', {}, h('strong', { class: 'mono' }, tr.action), ` → `, wfStatus(tr.toStatus)),
        tr.comment ? h('div', { class: 'section-note' }, tr.comment) : null,
      ));
    }
    return list;
  }

  renderTabs();
  await load();
  return root;
}
