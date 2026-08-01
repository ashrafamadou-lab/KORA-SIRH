import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, scopeCovers, unionPermissions, type PrincipalAccess } from './rbac.ts';

const SITE_A = { type: 'site', ref: 'site-a' } as const;
const SITE_B = { type: 'site', ref: 'site-b' } as const;

const hrOfficerSiteA: PrincipalAccess = {
  roles: [{ roleKey: 'hr_officer', permissions: ['employees.view', 'employees.edit'] }],
  scopes: [{ type: 'site', ref: 'site-a' }],
};

test('unionPermissions : cumul de rôles = union simple', () => {
  const u = unionPermissions([
    { roleKey: 'hr_officer', permissions: ['employees.view', 'employees.edit'] },
    { roleKey: 'auditor', permissions: ['employees.view', 'audit.view'] },
  ]);
  assert.deepEqual([...u].sort(), ['audit.view', 'employees.edit', 'employees.view']);
});

test('scopeCovers : tenant couvre tout ; sinon correspondance exacte type+réf', () => {
  assert.equal(scopeCovers({ type: 'tenant' }, SITE_A), true);
  assert.equal(scopeCovers({ type: 'tenant' }, undefined), true);
  assert.equal(scopeCovers({ type: 'site', ref: 'site-a' }, SITE_A), true);
  assert.equal(scopeCovers({ type: 'site', ref: 'site-a' }, SITE_B), false);
  assert.equal(scopeCovers({ type: 'department', ref: 'd1' }, SITE_A), false, 'types différents');
  assert.equal(scopeCovers({ type: 'site', ref: null }, SITE_A), false, 'réf manquante');
});

test('can : la permission ne s’exerce que dans la portée (le HR Officer du site A ne voit pas le site B)', () => {
  assert.equal(can(hrOfficerSiteA, 'employees.view', SITE_A), true);
  assert.equal(can(hrOfficerSiteA, 'employees.view', SITE_B), false);
  assert.equal(can(hrOfficerSiteA, 'salaries.view', SITE_A), false, 'permission absente');
});

test('can : anti-élévation — permission sans portée couvrante = refus', () => {
  const sansPortee: PrincipalAccess = { roles: hrOfficerSiteA.roles, scopes: [] };
  assert.equal(can(sansPortee, 'employees.view', SITE_A), false);
  // action de niveau tenant : exige la portée tenant, pas une portée locale
  assert.equal(can(hrOfficerSiteA, 'employees.view', undefined), false);
  const adminTenant: PrincipalAccess = {
    roles: [{ roleKey: 'hr_director', permissions: ['parameters.view'] }],
    scopes: [{ type: 'tenant' }],
  };
  assert.equal(can(adminTenant, 'parameters.view'), true);
});

test('can : cumul de rôles borné par la portée de l’utilisateur', () => {
  const cumul: PrincipalAccess = {
    roles: [
      { roleKey: 'hr_officer', permissions: ['employees.view'] },
      { roleKey: 'payroll_officer', permissions: ['salaries.view'] },
    ],
    scopes: [{ type: 'site', ref: 'site-a' }],
  };
  assert.equal(can(cumul, 'salaries.view', SITE_A), true);
  assert.equal(can(cumul, 'salaries.view', SITE_B), false);
});
