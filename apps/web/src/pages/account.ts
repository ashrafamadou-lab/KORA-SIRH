/**
 * Espace personnel (E1 via PWA) : notifications, sessions actives (révocation ciblée
 * + « toutes les autres » avec confirmation), changement de mot de passe (politique
 * appliquée par le SERVEUR — le client ne duplique pas la règle).
 */
import { h } from '../core/dom.ts';
import { t } from '../core/i18n.ts';
import { fmtDateTime } from '../core/format.ts';
import type { Session } from '../core/session.ts';
import { ApiError, type ActiveSession, type NotificationItem } from '../core/api.ts';
import { button, confirmModal, dataTable, field, guardedSubmit, pageTitle, statusBadge, stateForError, states, toast } from '../ui/kit.ts';

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function notificationsPage(session: Session, onUnread: (n: number) => void): Promise<HTMLElement> {
  const root = h('div', {});
  root.appendChild(pageTitle(t('notif.title')));
  let unreadOnly = false;
  const toggle = h('label', { class: 'btn btn-ghost' });
  const check = h('input', { type: 'checkbox' }) as HTMLInputElement;
  check.style.width = 'auto';
  check.style.minHeight = 'auto';
  check.addEventListener('change', () => {
    unreadOnly = check.checked;
    void load();
  });
  toggle.appendChild(check);
  toggle.appendChild(document.createTextNode(` ${t('notif.unreadOnly')}`));
  root.appendChild(h('div', { class: 'filters' }, toggle));
  const zone = h('div', {});
  root.appendChild(zone);

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const res = await session.api.call<{ items: NotificationItem[]; unreadCount: number }>('notifications', {
        query: { unread: unreadOnly ? 1 : undefined, limit: 100 },
      });
      onUnread(res.unreadCount);
      if (res.items.length === 0) {
        zone.replaceChildren(states.empty('notif.empty'));
        return;
      }
      const list = h('div', {});
      for (const n of res.items) {
        const card = h('div', { class: 'glass card' });
        card.style.marginBottom = '10px';
        if (n.readAt === null) card.classList.add('glass-strong');
        card.appendChild(h('div', { class: 'page-title' },
          h('strong', {}, n.subject),
          n.mandatory ? statusBadge('pending', t('notif.mandatoryBadge')) : null,
          h('span', { class: 'spacer' }),
          h('span', { class: 'section-note' }, fmtDateTime(n.createdAt)),
        ));
        card.appendChild(h('p', {}, n.body));
        const actions = h('div', { class: 'modal-actions' });
        if (n.readAt === null) {
          actions.appendChild(button(t('notif.markRead'), async () => {
            await session.api.call('notificationRead', { params: { id: n.id } });
            await load();
          }, { small: true }));
        }
        actions.appendChild(button(t('notif.archive'), async () => {
          await session.api.call('notificationArchive', { params: { id: n.id } });
          await load();
        }, { small: true, variant: 'ghost' }));
        card.appendChild(actions);
        list.appendChild(card);
      }
      zone.replaceChildren(list);
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }

  await load();
  return root;
}

// ---------------------------------------------------------------------------
// Sessions actives
// ---------------------------------------------------------------------------

export async function sessionsPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  const revokeOthersBtn = button(t('session.revokeOthers'), async () => {
    const okConfirm = await confirmModal(t('session.revokeOthersConfirm'), { danger: true });
    if (!okConfirm) return;
    await session.api.call('revokeOtherSessions', {});
    toast(t('session.othersRevoked'), 'ok');
    await load();
  }, { variant: 'danger' });
  root.appendChild(pageTitle(t('session.title'), revokeOthersBtn));
  const zone = h('div', {});
  root.appendChild(zone);

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const rows = await session.api.call<ActiveSession[]>('sessions', {});
      zone.replaceChildren(dataTable<ActiveSession>({
        columns: [
          {
            key: 'device', labelKey: 'session.device',
            render: (r) => h('span', {}, r.userAgent ?? t('app.none'), ' ',
              r.current ? statusBadge('active', t('session.current')) : null),
          },
          { key: 'ip', labelKey: 'session.ip', render: (r) => h('span', { class: 'mono' }, r.ip ?? t('app.none')) },
          { key: 'createdAt', labelKey: 'session.createdAt', render: (r) => fmtDateTime(r.createdAt) },
          { key: 'lastSeen', labelKey: 'session.lastSeen', render: (r) => fmtDateTime(r.lastSeenAt) },
          {
            key: 'actions', labelKey: 'app.actions',
            render: (r) => r.current ? null : button(t('session.revoke'), async () => {
              const okConfirm = await confirmModal(t('session.revokeConfirm'), { danger: true });
              if (!okConfirm) return;
              await session.api.call('revokeSession', { params: { id: r.id } });
              toast(t('session.revoked'), 'ok');
              await load();
            }, { small: true, variant: 'danger' }),
          },
        ],
        rows,
      }));
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }

  await load();
  return root;
}

// ---------------------------------------------------------------------------
// Changement de mot de passe
// ---------------------------------------------------------------------------

export function passwordPage(session: Session): HTMLElement {
  const root = h('div', {});
  root.appendChild(pageTitle(t('password.title')));
  const current = field('password.current', { type: 'password', required: true, autocomplete: 'current-password' });
  const next = field('password.new', { type: 'password', required: true, autocomplete: 'new-password' });
  const confirm = field('password.confirmNew', { type: 'password', required: true, autocomplete: 'new-password' });
  const submitBtn = button(t('password.submit'), null, { variant: 'primary', type: 'submit' }) as HTMLButtonElement;
  const form = h('form', { novalidate: 'novalidate' }, current.wrap, next.wrap, confirm.wrap, submitBtn) as HTMLFormElement;

  guardedSubmit(form, submitBtn, async () => {
    next.setError(null);
    confirm.setError(null);
    current.setError(null);
    if (next.input.value !== confirm.input.value) {
      confirm.setError(t('password.mismatch'));
      return;
    }
    try {
      await session.api.call('changePassword', {
        body: { currentPassword: current.input.value, newPassword: next.input.value },
      });
      current.input.value = '';
      next.input.value = '';
      confirm.input.value = '';
      toast(t('password.changed'), 'ok');
    } catch (e) {
      const err = e as ApiError;
      if (err.kind === 'invalid') next.setError(t('password.rejected'));
      else if (err.kind === 'unauthorized') current.setError(t('login.failed'));
      else toast(t('state.error'), 'err');
    }
  });

  const box = h('div', { class: 'glass card' });
  box.style.maxWidth = '460px';
  box.appendChild(h('p', { class: 'section-note' }, t('password.hint')));
  box.appendChild(form);
  root.appendChild(box);
  return root;
}
