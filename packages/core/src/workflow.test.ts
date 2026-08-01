import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTerminal, resolveTransition } from './workflow-machine.ts';
import {
  evaluateCondition,
  firstActiveStepFrom,
  isLastEffectiveStep,
  type WorkflowStepDef,
} from './workflow-conditions.ts';
import { canDecide, canDelegate, matchesAssignment, type ActorContext } from './workflow-authz.ts';

// ---------- Machine à états ----------

test('machine : approve avance ou clôture selon la dernière étape effective', () => {
  const mid = resolveTransition({ status: 'pending', action: 'approve', isLastEffectiveStep: false });
  assert.deepEqual(mid, { ok: true, nextStatus: 'pending', advancesStep: true });
  const last = resolveTransition({ status: 'pending', action: 'approve', isLastEffectiveStep: true });
  assert.deepEqual(last, { ok: true, nextStatus: 'approved', advancesStep: false });
});

test('machine : reject/return/cancel mènent aux bons états', () => {
  assert.equal(resolveTransition({ status: 'pending', action: 'reject', isLastEffectiveStep: false }).ok, true);
  assert.deepEqual(
    resolveTransition({ status: 'pending', action: 'return', isLastEffectiveStep: false }),
    { ok: true, nextStatus: 'returned', advancesStep: false },
  );
  assert.deepEqual(
    resolveTransition({ status: 'pending', action: 'cancel', isLastEffectiveStep: true }),
    { ok: true, nextStatus: 'cancelled', advancesStep: false },
  );
});

test('machine : aucune action sur un état terminal', () => {
  for (const status of ['approved', 'rejected', 'cancelled', 'expired'] as const) {
    assert.equal(isTerminal(status), true);
    assert.equal(resolveTransition({ status, action: 'approve', isLastEffectiveStep: true }).ok, false);
  }
});

test('machine : un dossier retourné n’accepte que l’annulation', () => {
  assert.equal(resolveTransition({ status: 'returned', action: 'approve', isLastEffectiveStep: false }).ok, false);
  assert.equal(resolveTransition({ status: 'returned', action: 'cancel', isLastEffectiveStep: false }).ok, true);
});

// ---------- Conditions / branches ----------

const steps: WorkflowStepDef[] = [
  { index: 0, name: 'Manager', approverType: 'role', approverRef: 'manager' },
  { index: 1, name: 'Finance', approverType: 'role', approverRef: 'finance', condition: { field: 'amount', op: 'gte', value: 100000 } },
  { index: 2, name: 'DG', approverType: 'role', approverRef: 'dg', condition: { field: 'amount', op: 'gte', value: 1000000 } },
];

test('conditions : opérateurs de comparaison et types incompatibles', () => {
  assert.equal(evaluateCondition({ field: 'amount', op: 'gte', value: 100000 }, { amount: 100000 }), true);
  assert.equal(evaluateCondition({ field: 'amount', op: 'gt', value: 100000 }, { amount: 100000 }), false);
  assert.equal(evaluateCondition({ field: 'type', op: 'in', value: ['a', 'b'] }, { type: 'b' }), true);
  assert.equal(evaluateCondition({ field: 'amount', op: 'gte', value: 5 }, { amount: 'x' }), false);
  assert.equal(evaluateCondition(null, {}), true, 'absence de condition = toujours active');
});

test('branches : petite demande saute Finance et DG', () => {
  const ctx = { amount: 5000 };
  assert.equal(firstActiveStepFrom(steps, ctx, 0), 0);
  assert.equal(isLastEffectiveStep(steps, ctx, 0), true, 'seule l’étape Manager est effective');
});

test('branches : demande moyenne active Finance mais pas DG', () => {
  const ctx = { amount: 250000 };
  assert.equal(firstActiveStepFrom(steps, ctx, 1), 1);
  assert.equal(isLastEffectiveStep(steps, ctx, 0), false);
  assert.equal(isLastEffectiveStep(steps, ctx, 1), true);
  assert.equal(firstActiveStepFrom(steps, ctx, 2), null, 'DG sauté');
});

test('branches : grosse demande active les trois étapes', () => {
  const ctx = { amount: 2000000 };
  assert.equal(isLastEffectiveStep(steps, ctx, 1), false);
  assert.equal(isLastEffectiveStep(steps, ctx, 2), true);
});

// ---------- Autorisation d'étape ----------

const roleStep: WorkflowStepDef = { index: 0, name: 'Manager', approverType: 'role', approverRef: 'manager' };
const requester = 'user-requester';

function actor(userId: string, roleKeys: string[] = [], scopes: ActorContext['scopes'] = []): ActorContext {
  return { userId, roleKeys, scopes };
}

test('authz : assignation par rôle, utilisateur, manager, portée', () => {
  assert.equal(matchesAssignment(actor('u1', ['manager']), { step: roleStep, instanceContext: {}, createdBy: requester }), true);
  assert.equal(matchesAssignment(actor('u2', ['finance']), { step: roleStep, instanceContext: {}, createdBy: requester }), false);

  const userStep: WorkflowStepDef = { index: 0, name: 'X', approverType: 'user', approverRef: 'u9' };
  assert.equal(matchesAssignment(actor('u9'), { step: userStep, instanceContext: {}, createdBy: requester }), true);

  const mgrStep: WorkflowStepDef = { index: 0, name: 'Mgr', approverType: 'manager' };
  assert.equal(matchesAssignment(actor('boss'), { step: mgrStep, instanceContext: { managerUserId: 'boss' }, createdBy: requester }), true);
  assert.equal(matchesAssignment(actor('other'), { step: mgrStep, instanceContext: { managerUserId: 'boss' }, createdBy: requester }), false);

  const scopeStep: WorkflowStepDef = { index: 0, name: 'Site', approverType: 'scope', approverRef: 'site' };
  const withScope = actor('u5', [], [{ type: 'site', ref: 'site-a' }]);
  assert.equal(matchesAssignment(withScope, { step: scopeStep, instanceContext: { scopeRef: 'site-a' }, createdBy: requester }), true);
  assert.equal(matchesAssignment(withScope, { step: scopeStep, instanceContext: { scopeRef: 'site-b' }, createdBy: requester }), false);
});

test('authz : anti-auto-approbation (séparation des tâches)', () => {
  const asRequester = actor(requester, ['manager']);
  const strict = canDecide(asRequester, { step: roleStep, instanceContext: {}, createdBy: requester });
  assert.equal(strict.allowed, false, 'le demandeur ne peut pas approuver sa propre demande');

  const relaxedStep: WorkflowStepDef = { ...roleStep, selfApprovalAllowed: true };
  assert.equal(canDecide(asRequester, { step: relaxedStep, instanceContext: {}, createdBy: requester }).allowed, true);

  const other = actor('someone-else', ['manager']);
  assert.equal(canDecide(other, { step: roleStep, instanceContext: {}, createdBy: requester }).allowed, true);
});

test('authz : délégation d’instance prioritaire ; seul un assigné peut déléguer', () => {
  const delegatee = actor('deleg', []); // n'a pas le rôle manager
  const ctx = { step: roleStep, instanceContext: {}, createdBy: requester, delegatedToUserId: 'deleg' };
  assert.equal(matchesAssignment(delegatee, ctx), true, 'le délégataire explicite est autorisé');
  assert.equal(canDecide(delegatee, ctx).allowed, true);

  const manager = actor('mgr', ['manager']);
  assert.equal(canDelegate(manager, { step: roleStep, instanceContext: {}, createdBy: requester }).allowed, true);
  assert.equal(canDelegate(actor('nobody'), { step: roleStep, instanceContext: {}, createdBy: requester }).allowed, false);
});

// ---------- Cycle de vie des paramètres (E4) ----------
import {
  activationAllowed,
  activationStatusFor,
  canTransition,
  isContentEditable,
  RESOLVABLE_STATUSES,
} from './parameter-lifecycle.ts';

test('paramètres : transitions autorisées et interdites', () => {
  assert.equal(canTransition('draft', 'submitted'), true);
  assert.equal(canTransition('submitted', 'approved'), true);
  assert.equal(canTransition('approved', 'active'), true);
  assert.equal(canTransition('approved', 'scheduled'), true);
  assert.equal(canTransition('active', 'superseded'), true);
  assert.equal(canTransition('rejected', 'draft'), true, 'resoumission possible');
  // interdites
  assert.equal(canTransition('draft', 'active'), false, 'pas d’activation directe sans contreseing');
  assert.equal(canTransition('active', 'draft'), false);
  assert.equal(canTransition('superseded', 'active'), false);
  assert.equal(canTransition('retired', 'active'), false);
});

test('paramètres : contenu éditable en draft seulement', () => {
  assert.equal(isContentEditable('draft'), true);
  for (const s of ['submitted', 'approved', 'scheduled', 'active', 'superseded'] as const) {
    assert.equal(isContentEditable(s), false);
  }
});

test('paramètres : active vs scheduled selon la date d’effet', () => {
  assert.equal(activationStatusFor('2026-01-01', '2026-08-01'), 'active', 'effet passé → active');
  assert.equal(activationStatusFor('2026-08-01', '2026-08-01'), 'active', 'effet aujourd’hui → active');
  assert.equal(activationStatusFor('2027-01-01', '2026-08-01'), 'scheduled', 'effet futur → scheduled');
});

test('paramètres : résolution ne considère que active/scheduled/superseded', () => {
  assert.deepEqual([...RESOLVABLE_STATUSES].sort(), ['active', 'scheduled', 'superseded']);
  for (const s of ['draft', 'submitted', 'approved', 'rejected', 'retired'] as const) {
    assert.equal(RESOLVABLE_STATUSES.has(s), false, `${s} jamais résolu`);
  }
});

test('paramètres : séparation des tâches à l’activation (créateur ≠ activateur pour juridique)', () => {
  assert.equal(activationAllowed({ createdBy: 'u1', actorUserId: 'u1', isLegalSensitive: true }).allowed, false);
  assert.equal(activationAllowed({ createdBy: 'u1', actorUserId: 'u2', isLegalSensitive: true }).allowed, true);
  // paramètre ordinaire : le créateur peut activer (pas de contrainte juridique)
  assert.equal(activationAllowed({ createdBy: 'u1', actorUserId: 'u1', isLegalSensitive: false }).allowed, true);
});
