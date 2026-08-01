/**
 * Administration des utilisateurs et rôles (E2 via PWA). Toute action sensible exige
 * une confirmation ; l'anti-élévation (rôles bornés aux permissions de l'acteur) est
 * appliquée par le SERVEUR — le 403 est montré tel quel, jamais contourné.
 */
import { h } from '../core/dom.ts';
import { t } from '../core/i18n.ts';
import type { Session } from '../core/session.ts';
import { ApiError, type AdminUserRow, type RoleRow } from '../core/api.ts';
import { button, confirmModal, dataTable, drawer, field, guardedSubmit, pageTitle, statusBadge, stateForError, states, toast } from '../ui/kit.ts';

export async function adminUsersPage(session: Session): Promise<HTMLElement> {
  const root = h('div', {});
  const canCreate = session.hasPermission('users.create');
  const canManageRoles = session.hasPermission('users.manage_roles');
  const canEdit = session.hasPermission('users.edit');
  const canRevoke = session.hasPermission('sessions.revoke');

  const createBtn = canCreate ? button(t('admin.createUser'), () => openCreate(), { variant: 'primary' }) : null;
  root.appendChild(pageTitle(t('admin.usersTitle'), createBtn));
  const zone = h('div', {});
  root.appendChild(zone);
  const rolesBox = h('div', {});
  rolesBox.style.marginTop = '22px';
  root.appendChild(rolesBox);

  let roles: RoleRow[] = [];

  async function load(): Promise<void> {
    zone.replaceChildren(states.loading());
    try {
      const [users, rolesRes] = await Promise.all([
        session.api.call<AdminUserRow[]>('adminUsers', {}),
        session.api.call<RoleRow[]>('adminRoles', {}).catch(() => [] as RoleRow[]),
      ]);
      roles = rolesRes;
      zone.replaceChildren(dataTable<AdminUserRow>({
        columns: [
          { key: 'email', labelKey: 'admin.email', render: (r) => h('span', { class: 'mono' }, r.email) },
          {
            key: 'active', labelKey: 'emp.status',
            render: (r) => statusBadge(r.isActive ? 'active' : 'inactive', r.isActive ? t('admin.active') : t('admin.inactive')),
          },
          { key: 'mfa', labelKey: 'admin.mfa', render: (r) => r.mfaEnabled ? t('app.yes') : t('app.no') },
          { key: 'roles', labelKey: 'admin.roles', render: (r) => h('span', { class: 'mono' }, r.roles.join(', ') || t('app.none')) },
          { key: 'actions', labelKey: 'app.actions', render: (r) => userActions(r) },
        ],
        rows: users,
      }));
      renderRolesCatalog();
    } catch (e) {
      zone.replaceChildren(stateForError(e as ApiError, () => void load()));
    }
  }

  function userActions(u: AdminUserRow): HTMLElement {
    const wrap = h('div', {});
    wrap.style.display = 'flex';
    wrap.style.gap = '6px';
    wrap.style.flexWrap = 'wrap';
    if (canEdit) {
      wrap.appendChild(u.isActive
        ? button(t('admin.deactivate'), async () => {
            if (!(await confirmModal(t('admin.deactivateConfirm'), { danger: true }))) return;
            await run(() => session.api.call('adminDeactivateUser', { params: { id: u.id } }));
          }, { small: true, variant: 'danger' })
        : button(t('admin.activate'), async () => {
            if (!(await confirmModal(t('admin.activateConfirm')))) return;
            await run(() => session.api.call('adminActivateUser', { params: { id: u.id } }));
          }, { small: true }));
    }
    if (canManageRoles) {
      wrap.appendChild(button(t('admin.assignRoles'), () => openRoles(u), { small: true }));
    }
    if (canRevoke) {
      wrap.appendChild(button(t('admin.revokeSessions'), async () => {
        if (!(await confirmModal(t('admin.revokeSessionsConfirm'), { danger: true }))) return;
        await run(() => session.api.call('adminRevokeUserSessions', { params: { id: u.id } }));
      }, { small: true, variant: 'ghost' }));
    }
    return wrap;
  }

  async function run(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
      toast(t('admin.saved'), 'ok');
      await load();
    } catch (e) {
      const err = e as ApiError;
      toast(err.kind === 'forbidden' ? t('state.forbiddenBody') : t('state.error'), 'err');
    }
  }

  function openCreate(): void {
    const email = field('admin.email', { type: 'email', required: true });
    const submitBtn = button(t('admin.createUser'), null, { variant: 'primary', type: 'submit' }) as HTMLButtonElement;
    const form = h('form', { novalidate: 'novalidate' }, email.wrap, submitBtn) as HTMLFormElement;
    const d = drawer(t('admin.createUser'), form);
    guardedSubmit(form, submitBtn, async () => {
      try {
        await session.api.call('adminCreateUser', { body: { email: email.input.value.trim() } });
        toast(t('admin.userCreated'), 'ok');
        d.close();
        await load();
      } catch (e) {
        const err = e as ApiError;
        email.setError(err.kind === 'invalid' || err.kind === 'conflict' ? t('form.invalid') : t('state.error'));
      }
    });
  }

  function openRoles(u: AdminUserRow): void {
    const form = h('form', { novalidate: 'novalidate' }) as HTMLFormElement;
    const checks: Array<{ key: string; input: HTMLInputElement }> = [];
    for (const role of roles) {
      const cid = `role-${role.id}`;
      const input = h('input', { type: 'checkbox', id: cid }) as HTMLInputElement;
      input.style.width = 'auto';
      input.style.minHeight = 'auto';
      input.checked = u.roles.includes(role.key);
      checks.push({ key: role.key, input });
      form.appendChild(h('div', { class: 'field' },
        h('label', { for: cid },
          input, ' ', h('strong', {}, role.name), ' ', h('span', { class: 'mono section-note' }, role.key),
          role.isSystem ? h('span', { class: 'section-note' }, ` — ${t('admin.systemRole')}`) : null,
        ),
        h('span', { class: 'hint mono' }, role.permissions.join(', ')),
      ));
    }
    const submitBtn = button(t('app.save'), null, { variant: 'primary', type: 'submit' }) as HTMLButtonElement;
    form.appendChild(submitBtn);
    const d = drawer(`${t('admin.assignRoles')} — ${u.email}`,
      h('p', { class: 'section-note' }, t('admin.assignRolesHint')),
      form,
    );
    guardedSubmit(form, submitBtn, async () => {
      try {
        await session.api.call('adminAssignRoles', {
          params: { id: u.id },
          body: { roles: checks.filter((c) => c.input.checked).map((c) => c.key) },
        });
        toast(t('admin.saved'), 'ok');
        d.close();
        await load();
      } catch (e) {
        const err = e as ApiError;
        toast(err.kind === 'forbidden' ? t('admin.assignRolesHint') : t('state.error'), 'err');
      }
    });
  }

  function renderRolesCatalog(): void {
    rolesBox.replaceChildren();
    if (roles.length === 0) return;
    const box = h('div', { class: 'glass card' });
    box.appendChild(h('h2', {}, t('admin.rolesCatalog')));
    box.appendChild(dataTable<RoleRow>({
      columns: [
        { key: 'key', labelKey: 'org.code', render: (r) => h('span', { class: 'mono' }, r.key) },
        { key: 'name', labelKey: 'org.label', render: (r) => r.name },
        { key: 'perm', labelKey: 'admin.permissions', render: (r) => h('span', { class: 'mono section-note' }, r.permissions.join(', ') || t('app.none')) },
      ],
      rows: roles,
    }));
    rolesBox.appendChild(box);
  }

  await load();
  return root;
}
