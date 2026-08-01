import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { auditAuth } from '../auth/audit.util';
import {
  assertSafeVariables,
  backoffDelayMs,
  channelsFor,
  nextDeliveryStatus,
  pickLocale,
  renderTemplate,
  scrubText,
  validateTemplateContent,
  validateValues,
  type NotifyChannel,
  type NotifyLocale,
  type OutboundChannel,
  type SafetyViolation,
  type ScalarValue,
  type TemplateContent,
} from '../../../../packages/core/src/notify.ts';
import type { WorkflowStepDef } from '../../../../packages/core/src/workflow-conditions.ts';

// ---------------------------------------------------------------------------
// Types publics du service
// ---------------------------------------------------------------------------

/** Destinataires d'un événement : utilisateur précis, rôle, ou portée organisationnelle. */
export type RecipientSpec =
  | { userId: string }
  | { roleKey: string }
  | { scopeType: string; scopeRef: string | null };

export interface PublishInput {
  eventKey: string;
  templateKey: string;
  payload: Record<string, unknown>;
  recipients: RecipientSpec[];
  source?: 'business' | 'workflow' | 'system';
  subjectType?: string | null;
  subjectId?: string | null;
  createdBy?: string | null;
  /**
   * Mode workflow : le moteur fournit un CATALOGUE de variables et le modèle en
   * consomme un sous-ensemble — les variables non déclarées sont simplement ignorées
   * (au lieu d'être rejetées comme pour une publication métier stricte).
   */
  restrictToTemplateVariables?: boolean;
}

export type PublishOutcome =
  | { kind: 'published'; eventId: string; recipients: number; inApp: number; queued: number }
  | { kind: 'duplicate'; eventId: string | null }
  | { kind: 'no_template' }
  | { kind: 'invalid_variables'; missing: string[]; unknown: string[] }
  | { kind: 'unsafe_variables'; violations: SafetyViolation[] }
  | { kind: 'invalid'; reason: string };

export type SimpleOutcome = { kind: 'ok' } | { kind: 'not_found' };

export type TemplateOutcome =
  | { kind: 'ok'; id: string; version: number }
  | { kind: 'invalid'; issues: string[] }
  | { kind: 'not_found' }
  | { kind: 'not_draft' };

export type QueueAdminOutcome =
  | { kind: 'ok'; status: string }
  | { kind: 'not_found' }
  | { kind: 'invalid_state'; status: string };

export interface ProcessQueueResult {
  processed: number;
  sent: number;
  failed: number;
  deadLettered: number;
}

export interface WorkflowNotifyEvent {
  kind: 'step_pending' | 'approved' | 'rejected' | 'returned' | 'cancelled' | 'escalated' | 'delegated';
  instanceId: string;
  transitionSeq: number;
  requesterId: string;
  definitionKey: string;
  subjectType?: string | null;
  subjectId?: string | null;
  step?: WorkflowStepDef | null;
  context?: Record<string, unknown>;
  delegateUserId?: string | null;
}

interface TemplateRow {
  id: string;
  key: string;
  version: number;
  status: string;
  name: string;
  subject_fr: string;
  subject_en: string;
  body_fr: string;
  body_en: string;
  variables: string[];
  channels: NotifyChannel[];
  mandatory: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_KEY_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

// Marqueurs du transport simulé — déterministes, pour les tests uniquement.
const SIM_FAIL_ALWAYS = '[ECHEC-SIMULE-TOUJOURS]';
const SIM_FAIL_FIRST = '[ECHEC-SIMULE-1]';

/**
 * Transport SIMULÉ (DEMO/TEST ONLY — aucun fournisseur email/SMS/push payant n'est
 * branché, décision sponsor E5). Il réussit toujours, SAUF si le contenu rendu porte un
 * marqueur d'échec déterministe : [ECHEC-SIMULE-TOUJOURS] échoue à chaque tentative,
 * [ECHEC-SIMULE-1] échoue à la première tentative seulement (panne transitoire).
 * Le branchement d'un fournisseur réel (Phase 2) remplacera cette classe derrière la
 * même interface, avec envoi HORS transaction et état 'processing' persistant.
 */
function simulatedSend(input: { subject: string; body: string; attemptNo: number }):
  | { ok: true }
  | { ok: false; errorCode: string; errorMessage: string } {
  const content = `${input.subject}\n${input.body}`;
  if (content.includes(SIM_FAIL_ALWAYS)) {
    return { ok: false, errorCode: 'SIM_FAIL', errorMessage: 'échec simulé permanent (marqueur de test)' };
  }
  if (content.includes(SIM_FAIL_FIRST) && input.attemptNo === 1) {
    return { ok: false, errorCode: 'SIM_FAIL_TRANSIENT', errorMessage: 'échec simulé transitoire (1re tentative)' };
  }
  return { ok: true };
}

/**
 * Moteur de notifications (E5). Discipline transactionnelle : les callbacks withTenant
 * retournent des RÉSULTATS métier ; les exceptions HTTP sont levées par les contrôleurs
 * APRÈS commit. publishEventTx / notifyWorkflowEventTx s'exécutent DANS la transaction
 * de l'appelant : une notification n'existe que si la transition métier qui la déclenche
 * est committée — et réciproquement, un refus de notification ne casse JAMAIS le métier
 * (résultats, pas d'exception).
 */
@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- configuration opérationnelle (env — PAS des paramètres légaux) ----------

  private maxAttempts(): number {
    const n = Number(process.env.KORA_NOTIFY_MAX_ATTEMPTS ?? 5);
    return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 5;
  }

  private backoffOptions(): { baseMs: number; factor: number; maxMs: number } {
    const base = Number(process.env.KORA_NOTIFY_BACKOFF_BASE_MS ?? 60_000);
    const factor = Number(process.env.KORA_NOTIFY_BACKOFF_FACTOR ?? 2);
    const max = Number(process.env.KORA_NOTIFY_BACKOFF_MAX_MS ?? 3_600_000);
    return {
      baseMs: Number.isFinite(base) && base >= 0 ? base : 60_000,
      factor: Number.isFinite(factor) && factor >= 1 ? factor : 2,
      maxMs: Number.isFinite(max) && max >= 0 ? max : 3_600_000,
    };
  }

  // ---------- publication d'événements ----------

  async publishEvent(tenantId: string, input: PublishInput): Promise<PublishOutcome> {
    return this.prisma.withTenant<PublishOutcome>(tenantId, (tx) => this.publishEventTx(tx, tenantId, input));
  }

  /**
   * Publication DANS la transaction de l'appelant. Ordre strict :
   *  1. filtre anti-secrets (aucune écriture si violation) ;
   *  2. résolution du modèle actif (pas de modèle ⇒ rien n'est consommé : une fois le
   *     modèle créé, une publication ultérieure du même fait métier reste possible) ;
   *  3. validation des variables contre la liste fermée du modèle ;
   *  4. INSERT idempotent de l'événement (clé unique par tenant) ;
   *  5. résolution + dédoublonnage des destinataires, rendu par langue, notification
   *     logique unique par destinataire, livraisons par canal selon préférences.
   */
  async publishEventTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: PublishInput,
  ): Promise<PublishOutcome> {
    if (!EVENT_KEY_RE.test(input.eventKey)) return { kind: 'invalid', reason: 'eventKey invalide' };

    const safety = assertSafeVariables(input.payload);
    if (!safety.ok) return { kind: 'unsafe_variables', violations: safety.violations };

    const tpl = await this.activeTemplate(tx, input.templateKey);
    if (!tpl) return { kind: 'no_template' };

    let values: Record<string, ScalarValue> = safety.values;
    if (input.restrictToTemplateVariables) {
      values = Object.fromEntries(Object.entries(values).filter(([k]) => tpl.variables.includes(k)));
    }
    const vv = validateValues(tpl.variables, values);
    if (!vv.ok) return { kind: 'invalid_variables', missing: vv.missing, unknown: vv.unknown };

    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO notify.events
        (tenant_id, event_key, template_key, template_version, payload, source, subject_type, subject_id, created_by)
      VALUES (${tenantId}::uuid, ${input.eventKey}, ${tpl.key}, ${tpl.version},
              ${JSON.stringify(values)}::jsonb, ${input.source ?? 'business'},
              ${input.subjectType ?? null}, ${input.subjectId ?? null}::uuid, ${input.createdBy ?? null}::uuid)
      ON CONFLICT (tenant_id, event_key) DO NOTHING
      RETURNING id`;
    if (inserted.length === 0) {
      const existing = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM notify.events WHERE event_key = ${input.eventKey}`;
      return { kind: 'duplicate', eventId: existing[0]?.id ?? null };
    }
    const eventId = inserted[0]!.id;

    const userIds = await this.resolveRecipients(tx, input.recipients);
    let inApp = 0;
    let queued = 0;
    for (const userId of userIds) {
      const profile = await this.recipientProfile(tx, userId);
      if (!profile) continue; // inactif ou supprimé : jamais notifié
      const rendered = renderTemplate(this.toContent(tpl), profile.locale, values);
      if (!rendered.ok) continue; // défensif — validé plus haut
      const notif = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO notify.notifications
          (tenant_id, event_id, user_id, template_key, template_version, locale, subject, body, mandatory)
        VALUES (${tenantId}::uuid, ${eventId}::uuid, ${userId}::uuid, ${tpl.key}, ${tpl.version},
                ${profile.locale}, ${rendered.subject}, ${rendered.body}, ${tpl.mandatory})
        ON CONFLICT (tenant_id, event_id, user_id) DO NOTHING
        RETURNING id`;
      if (notif.length === 0) continue;
      const notificationId = notif[0]!.id;

      const channels = channelsFor({
        templateChannels: tpl.channels,
        mandatory: tpl.mandatory,
        preferences: profile.preferences,
      });
      for (const channel of channels) {
        if (channel === 'in_app') {
          await tx.$executeRaw`
            INSERT INTO notify.deliveries
              (tenant_id, notification_id, channel, status, attempt_count, max_attempts, sent_at)
            VALUES (${tenantId}::uuid, ${notificationId}::uuid, 'in_app', 'sent', 0, 1, now())`;
          inApp++;
        } else {
          await tx.$executeRaw`
            INSERT INTO notify.deliveries
              (tenant_id, notification_id, channel, status, attempt_count, max_attempts, next_attempt_at)
            VALUES (${tenantId}::uuid, ${notificationId}::uuid, ${channel}, 'pending', 0, ${this.maxAttempts()}, now())`;
          queued++;
        }
      }
    }
    return { kind: 'published', eventId, recipients: userIds.length, inApp, queued };
  }

  /**
   * Pont Workflow Engine → notifications, DANS la transaction du workflow.
   * La clé d'événement dérive de (instance, seq de transition) : un même événement de
   * workflow ne produit jamais deux notifications logiques. L'absence de modèle
   * `workflow.<kind>` chez le tenant est un non-événement (le métier n'attend pas).
   */
  async notifyWorkflowEventTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    evt: WorkflowNotifyEvent,
  ): Promise<void> {
    const recipients = this.workflowRecipients(evt);
    if (recipients.length === 0) return;
    await this.publishEventTx(tx, tenantId, {
      eventKey: `wf.${evt.instanceId}.${evt.transitionSeq}.${evt.kind}`,
      templateKey: `workflow.${evt.kind}`,
      payload: {
        workflow: evt.definitionKey,
        etape: evt.step?.name ?? '',
        action: evt.kind,
        reference: evt.subjectId ?? evt.instanceId,
      },
      recipients,
      source: 'workflow',
      subjectType: evt.subjectType ?? 'workflow_instance',
      subjectId: evt.subjectId ?? evt.instanceId,
      restrictToTemplateVariables: true,
    });
  }

  /** Destinataires d'un événement de workflow : approbateurs, demandeur, escalade, délégataire. */
  private workflowRecipients(evt: WorkflowNotifyEvent): RecipientSpec[] {
    switch (evt.kind) {
      case 'step_pending':
        return this.assigneeSpecs(evt.step, evt.context ?? {});
      case 'delegated':
        return evt.delegateUserId ? [{ userId: evt.delegateUserId }] : [];
      case 'escalated': {
        const specs: RecipientSpec[] = [{ userId: evt.requesterId }];
        const esc = evt.step?.escalation;
        if (esc) specs.push(esc.toType === 'user' ? { userId: esc.toRef } : { roleKey: esc.toRef });
        return specs;
      }
      case 'approved':
      case 'rejected':
      case 'returned':
      case 'cancelled':
        return [{ userId: evt.requesterId }];
      default:
        return [];
    }
  }

  /** Traduit l'assignation d'une étape (role / user / manager / scope) en destinataires. */
  private assigneeSpecs(step: WorkflowStepDef | null | undefined, context: Record<string, unknown>): RecipientSpec[] {
    if (!step) return [];
    switch (step.approverType) {
      case 'user':
        return step.approverRef ? [{ userId: step.approverRef }] : [];
      case 'role':
        return step.approverRef ? [{ roleKey: step.approverRef }] : [];
      case 'manager': {
        const mgr = context['managerUserId'];
        return typeof mgr === 'string' && UUID_RE.test(mgr) ? [{ userId: mgr }] : [];
      }
      case 'scope': {
        const ref = context['scopeRef'];
        return [{ scopeType: step.approverRef ?? 'tenant', scopeRef: typeof ref === 'string' ? ref : null }];
      }
      default:
        return [];
    }
  }

  /** Résout et DÉDOUBLONNE les destinataires en identifiants d'utilisateurs actifs. */
  private async resolveRecipients(tx: Prisma.TransactionClient, specs: RecipientSpec[]): Promise<string[]> {
    const ids = new Set<string>();
    for (const spec of specs) {
      if ('userId' in spec) {
        if (UUID_RE.test(spec.userId)) ids.add(spec.userId);
      } else if ('roleKey' in spec) {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT u.id FROM admin.users u
            JOIN admin.user_roles ur ON ur.user_id = u.id
            JOIN admin.roles r ON r.id = ur.role_id
           WHERE r.key = ${spec.roleKey} AND u.is_active AND u.deleted_at IS NULL`;
        for (const r of rows) ids.add(r.id);
      } else {
        // Portée : utilisateurs dont une portée COUVRE la cible (tenant couvre tout).
        if (spec.scopeRef !== null && !UUID_RE.test(spec.scopeRef)) continue;
        const rows = await tx.$queryRaw<Array<{ user_id: string }>>`
          SELECT DISTINCT s.user_id FROM admin.user_scopes s
            JOIN admin.users u ON u.id = s.user_id
           WHERE u.is_active AND u.deleted_at IS NULL
             AND (s.scope_type = 'tenant'
                  OR (s.scope_type = ${spec.scopeType} AND s.scope_ref = ${spec.scopeRef}::uuid))`;
        for (const r of rows) ids.add(r.user_id);
      }
    }
    // Filtre final : uniquement des comptes actifs (un userId direct peut être inactif).
    const result: string[] = [];
    for (const id of ids) {
      const ok = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM admin.users WHERE id = ${id}::uuid AND is_active AND deleted_at IS NULL`;
      if (ok.length > 0) result.push(id);
    }
    return result;
  }

  private async recipientProfile(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<{ locale: NotifyLocale; preferences: Partial<Record<OutboundChannel, boolean>> } | null> {
    const users = await tx.$queryRaw<Array<{ locale: string }>>`
      SELECT locale FROM admin.users WHERE id = ${userId}::uuid AND is_active AND deleted_at IS NULL`;
    if (users.length === 0) return null;
    const prefRows = await tx.$queryRaw<Array<{ channel: OutboundChannel; enabled: boolean }>>`
      SELECT channel, enabled FROM notify.preferences WHERE user_id = ${userId}::uuid`;
    const preferences: Partial<Record<OutboundChannel, boolean>> = {};
    for (const p of prefRows) preferences[p.channel] = p.enabled;
    return { locale: pickLocale(users[0]!.locale), preferences };
  }

  private async activeTemplate(tx: Prisma.TransactionClient, key: string): Promise<TemplateRow | null> {
    const rows = await tx.$queryRaw<TemplateRow[]>`
      SELECT id, key, version, status, name, subject_fr, subject_en, body_fr, body_en, variables, channels, mandatory
        FROM notify.templates WHERE key = ${key} AND status = 'active'`;
    return rows[0] ?? null;
  }

  private toContent(t: TemplateRow): TemplateContent {
    return {
      variables: t.variables,
      channels: t.channels,
      subjectFr: t.subject_fr,
      subjectEn: t.subject_en,
      bodyFr: t.body_fr,
      bodyEn: t.body_en,
    };
  }

  // ---------- file de livraison ----------

  /**
   * Traite les livraisons dues (pending/failed à échéance) sous FOR UPDATE SKIP LOCKED :
   * deux processeurs concurrents ne prennent jamais la même ligne. Chaque tentative est
   * journalisée SANS CONTENU (métadonnées + erreur courte assainie). Échec ⇒ réessai à
   * backoff exponentiel ; épuisement ⇒ dead_letter. Appelé par un déclencheur planifié
   * en production ; exposé comme opération (tick) pour être testable — même approche que
   * les escalades du Workflow Engine.
   */
  async processQueue(tenantId: string, opts: { limit?: number } = {}): Promise<ProcessQueueResult> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return this.prisma.withTenant<ProcessQueueResult>(tenantId, async (tx) => {
      const due = await tx.$queryRaw<Array<{
        id: string; status: string; attempt_count: number; max_attempts: number; channel: NotifyChannel;
        subject: string; body: string;
      }>>`
        SELECT d.id, d.status, d.attempt_count, d.max_attempts, d.channel, n.subject, n.body
          FROM notify.deliveries d
          JOIN notify.notifications n ON n.tenant_id = d.tenant_id AND n.id = d.notification_id
         WHERE d.status IN ('pending', 'failed') AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= now()
         ORDER BY d.next_attempt_at ASC
         LIMIT ${limit}
         FOR UPDATE OF d SKIP LOCKED`;

      const result: ProcessQueueResult = { processed: 0, sent: 0, failed: 0, deadLettered: 0 };
      for (const row of due) {
        await tx.$executeRaw`UPDATE notify.deliveries SET status = 'processing' WHERE id = ${row.id}::uuid`;
        const attemptNo = row.attempt_count + 1;
        // Transport simulé (DEMO/TEST ONLY) — synchrone et sans E/S, donc sûr DANS la
        // transaction. Un transport réel sortira de la transaction (Phase 2).
        const sendResult = simulatedSend({ subject: row.subject, body: row.body, attemptNo });
        const nextStatus = nextDeliveryStatus(sendResult.ok, attemptNo, row.max_attempts);
        const errorCode = sendResult.ok ? null : sendResult.errorCode.slice(0, 100);
        const errorMessage = sendResult.ok ? null : scrubText(sendResult.errorMessage, 300);

        await tx.$executeRaw`
          INSERT INTO notify.delivery_attempts
            (tenant_id, delivery_id, attempt_no, channel, transport, outcome, error_code, error_message)
          VALUES (${tenantId}::uuid, ${row.id}::uuid, ${attemptNo}, ${row.channel}, 'simulated',
                  ${sendResult.ok ? 'sent' : 'failed'}, ${errorCode}, ${errorMessage})`;

        if (nextStatus === 'sent') {
          await tx.$executeRaw`
            UPDATE notify.deliveries
               SET status = 'sent', attempt_count = ${attemptNo}, sent_at = now(),
                   next_attempt_at = NULL, last_error = NULL
             WHERE id = ${row.id}::uuid`;
          result.sent++;
        } else if (nextStatus === 'failed') {
          const delay = backoffDelayMs(attemptNo, this.backoffOptions());
          const next = new Date(Date.now() + delay);
          await tx.$executeRaw`
            UPDATE notify.deliveries
               SET status = 'failed', attempt_count = ${attemptNo},
                   next_attempt_at = ${next}::timestamptz, last_error = ${errorMessage}
             WHERE id = ${row.id}::uuid`;
          result.failed++;
        } else {
          await tx.$executeRaw`
            UPDATE notify.deliveries
               SET status = 'dead_letter', attempt_count = ${attemptNo},
                   next_attempt_at = NULL, last_error = ${errorMessage}
             WHERE id = ${row.id}::uuid`;
          result.deadLettered++;
        }
        result.processed++;
      }
      return result;
    });
  }

  // ---------- consultation self-service (toujours bornée à l'utilisateur) ----------

  async listMine(
    tenantId: string,
    userId: string,
    opts: { unreadOnly?: boolean; includeArchived?: boolean; limit?: number; offset?: number } = {},
  ): Promise<{ items: unknown[]; unreadCount: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const unreadOnly = opts.unreadOnly === true;
    const includeArchived = opts.includeArchived === true;
    return this.prisma.withTenant(tenantId, async (tx) => {
      const items = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, template_key AS "templateKey", template_version AS "templateVersion",
               locale, subject, body, mandatory, read_at AS "readAt", archived_at AS "archivedAt",
               created_at AS "createdAt"
          FROM notify.notifications
         WHERE user_id = ${userId}::uuid
           AND (${includeArchived} OR archived_at IS NULL)
           AND (NOT ${unreadOnly} OR read_at IS NULL)
         ORDER BY created_at DESC
         LIMIT ${limit} OFFSET ${offset}`;
      const unread = await tx.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM notify.notifications
         WHERE user_id = ${userId}::uuid AND read_at IS NULL AND archived_at IS NULL`;
      return { items, unreadCount: unread[0]?.n ?? 0 };
    });
  }

  async getMine(tenantId: string, userId: string, notificationId: string): Promise<Record<string, unknown> | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT n.id, n.template_key AS "templateKey", n.template_version AS "templateVersion",
               n.locale, n.subject, n.body, n.mandatory, n.read_at AS "readAt",
               n.archived_at AS "archivedAt", n.created_at AS "createdAt",
               COALESCE(jsonb_agg(jsonb_build_object(
                 'channel', d.channel, 'status', d.status, 'attemptCount', d.attempt_count,
                 'sentAt', d.sent_at) ORDER BY d.channel) FILTER (WHERE d.id IS NOT NULL), '[]') AS deliveries
          FROM notify.notifications n
          LEFT JOIN notify.deliveries d ON d.tenant_id = n.tenant_id AND d.notification_id = n.id
         WHERE n.id = ${notificationId}::uuid AND n.user_id = ${userId}::uuid
         GROUP BY n.id`;
      return rows[0] ?? null;
    });
  }

  /** Marque lue — uniquement SA notification (un autre id ⇒ not_found, jamais de fuite). */
  async markRead(tenantId: string, userId: string, notificationId: string): Promise<SimpleOutcome> {
    return this.prisma.withTenant<SimpleOutcome>(tenantId, async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE notify.notifications SET read_at = COALESCE(read_at, now())
         WHERE id = ${notificationId}::uuid AND user_id = ${userId}::uuid`;
      return n > 0 ? { kind: 'ok' } : { kind: 'not_found' };
    });
  }

  async archive(tenantId: string, userId: string, notificationId: string): Promise<SimpleOutcome> {
    return this.prisma.withTenant<SimpleOutcome>(tenantId, async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE notify.notifications
           SET archived_at = COALESCE(archived_at, now()), read_at = COALESCE(read_at, now())
         WHERE id = ${notificationId}::uuid AND user_id = ${userId}::uuid`;
      return n > 0 ? { kind: 'ok' } : { kind: 'not_found' };
    });
  }

  // ---------- préférences ----------

  async getPreferences(tenantId: string, userId: string): Promise<{
    locale: NotifyLocale;
    channels: Record<OutboundChannel, boolean>;
  }> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const profile = await this.recipientProfile(tx, userId);
      const channels: Record<OutboundChannel, boolean> = { email: true, sms: true, push: true };
      for (const c of Object.keys(channels) as OutboundChannel[]) {
        if (profile?.preferences[c] === false) channels[c] = false;
      }
      return { locale: profile?.locale ?? 'fr', channels };
    });
  }

  /**
   * Préférences par canal SORTANT uniquement (in_app est le socle, la table le
   * contraint) ; les notifications OBLIGATOIRES ignorent ces préférences à la
   * publication. La langue de rendu (fr/en) se règle ici aussi.
   */
  async setPreferences(
    tenantId: string,
    userId: string,
    input: { locale?: unknown; channels?: Partial<Record<OutboundChannel, unknown>> },
  ): Promise<{ kind: 'ok' } | { kind: 'invalid'; reason: string }> {
    const changes: Array<{ channel: OutboundChannel; enabled: boolean }> = [];
    if (input.channels !== undefined) {
      for (const [channel, enabled] of Object.entries(input.channels)) {
        if (!['email', 'sms', 'push'].includes(channel)) {
          return { kind: 'invalid', reason: `canal inconnu ou non désactivable : ${channel}` };
        }
        if (typeof enabled !== 'boolean') return { kind: 'invalid', reason: `valeur booléenne requise pour ${channel}` };
        changes.push({ channel: channel as OutboundChannel, enabled });
      }
    }
    let locale: NotifyLocale | null = null;
    if (input.locale !== undefined) {
      if (input.locale !== 'fr' && input.locale !== 'en') return { kind: 'invalid', reason: 'locale : fr ou en' };
      locale = input.locale;
    }
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (locale) {
        await tx.$executeRaw`UPDATE admin.users SET locale = ${locale} WHERE id = ${userId}::uuid`;
      }
      for (const c of changes) {
        await tx.$executeRaw`
          INSERT INTO notify.preferences (tenant_id, user_id, channel, enabled)
          VALUES (${tenantId}::uuid, ${userId}::uuid, ${c.channel}, ${c.enabled})
          ON CONFLICT (user_id, channel) DO UPDATE SET enabled = EXCLUDED.enabled`;
      }
      await auditAuth(tx, tenantId, {
        action: 'notify_prefs_updated', actorUserId: userId, recordId: userId,
        reason: changes.map((c) => `${c.channel}=${c.enabled}`).join(',') || (locale ? `locale=${locale}` : ''),
        module: 'notify',
      });
      return { kind: 'ok' };
    });
  }

  // ---------- administration des modèles (notify.manage, audité) ----------

  async createTemplate(
    tenantId: string,
    actorUserId: string,
    input: {
      key: string; name: string; subjectFr: string; subjectEn: string; bodyFr: string; bodyEn: string;
      variables: string[]; channels: NotifyChannel[]; mandatory: boolean;
    },
  ): Promise<TemplateOutcome> {
    if (!/^[a-z0-9_.]+$/.test(input.key) || input.key.length > 100) {
      return { kind: 'invalid', issues: ['clé invalide (minuscules, chiffres, _ et .)'] };
    }
    const validation = validateTemplateContent({
      variables: input.variables, channels: input.channels,
      subjectFr: input.subjectFr, subjectEn: input.subjectEn, bodyFr: input.bodyFr, bodyEn: input.bodyEn,
    });
    if (!validation.ok) return { kind: 'invalid', issues: validation.issues };
    return this.prisma.withTenant<TemplateOutcome>(tenantId, async (tx) => {
      const max = await tx.$queryRaw<Array<{ v: number | null }>>`
        SELECT max(version) AS v FROM notify.templates WHERE key = ${input.key}`;
      const version = (max[0]?.v ?? 0) + 1;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO notify.templates
          (tenant_id, key, version, name, subject_fr, subject_en, body_fr, body_en, variables, channels, mandatory, created_by)
        VALUES (${tenantId}::uuid, ${input.key}, ${version}, ${input.name},
                ${input.subjectFr}, ${input.subjectEn}, ${input.bodyFr}, ${input.bodyEn},
                ${JSON.stringify(input.variables)}::jsonb, ${JSON.stringify(input.channels)}::jsonb,
                ${input.mandatory}, ${actorUserId}::uuid)
        RETURNING id`;
      await auditAuth(tx, tenantId, {
        action: 'notify_template_created', actorUserId, recordId: rows[0]!.id,
        reason: `${input.key} v${version}`, module: 'notify',
      });
      return { kind: 'ok', id: rows[0]!.id, version };
    });
  }

  /** Modification d'un DRAFT uniquement — un modèle sorti de draft est figé (trigger SQL). */
  async updateTemplate(
    tenantId: string,
    actorUserId: string,
    templateId: string,
    input: {
      name: string; subjectFr: string; subjectEn: string; bodyFr: string; bodyEn: string;
      variables: string[]; channels: NotifyChannel[]; mandatory: boolean;
    },
  ): Promise<TemplateOutcome> {
    const validation = validateTemplateContent({
      variables: input.variables, channels: input.channels,
      subjectFr: input.subjectFr, subjectEn: input.subjectEn, bodyFr: input.bodyFr, bodyEn: input.bodyEn,
    });
    if (!validation.ok) return { kind: 'invalid', issues: validation.issues };
    return this.prisma.withTenant<TemplateOutcome>(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string; version: number }>>`
        SELECT status, version FROM notify.templates WHERE id = ${templateId}::uuid FOR UPDATE`;
      if (rows.length === 0) return { kind: 'not_found' };
      if (rows[0]!.status !== 'draft') return { kind: 'not_draft' };
      await tx.$executeRaw`
        UPDATE notify.templates
           SET name = ${input.name}, subject_fr = ${input.subjectFr}, subject_en = ${input.subjectEn},
               body_fr = ${input.bodyFr}, body_en = ${input.bodyEn},
               variables = ${JSON.stringify(input.variables)}::jsonb,
               channels = ${JSON.stringify(input.channels)}::jsonb, mandatory = ${input.mandatory}
         WHERE id = ${templateId}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'notify_template_updated', actorUserId, recordId: templateId, module: 'notify',
      });
      return { kind: 'ok', id: templateId, version: rows[0]!.version };
    });
  }

  /** Active un draft ; supersède l'éventuelle version active de la même clé. */
  async activateTemplate(tenantId: string, actorUserId: string, templateId: string): Promise<TemplateOutcome> {
    return this.prisma.withTenant<TemplateOutcome>(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string; key: string; version: number }>>`
        SELECT status, key, version FROM notify.templates WHERE id = ${templateId}::uuid FOR UPDATE`;
      if (rows.length === 0) return { kind: 'not_found' };
      if (rows[0]!.status !== 'draft') return { kind: 'not_draft' };
      await tx.$executeRaw`
        UPDATE notify.templates SET status = 'superseded'
         WHERE key = ${rows[0]!.key} AND status = 'active'`;
      await tx.$executeRaw`
        UPDATE notify.templates SET status = 'active', activated_at = now()
         WHERE id = ${templateId}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'notify_template_activated', actorUserId, recordId: templateId,
        reason: `${rows[0]!.key} v${rows[0]!.version}`, module: 'notify',
      });
      return { kind: 'ok', id: templateId, version: rows[0]!.version };
    });
  }

  async retireTemplate(tenantId: string, actorUserId: string, templateId: string): Promise<SimpleOutcome> {
    return this.prisma.withTenant<SimpleOutcome>(tenantId, async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE notify.templates SET status = 'retired'
         WHERE id = ${templateId}::uuid AND status IN ('draft', 'active', 'superseded')`;
      if (n === 0) return { kind: 'not_found' };
      await auditAuth(tx, tenantId, {
        action: 'notify_template_retired', actorUserId, recordId: templateId, module: 'notify',
      });
      return { kind: 'ok' };
    });
  }

  async listTemplates(tenantId: string): Promise<unknown[]> {
    return this.prisma.withTenant(tenantId, async (tx) =>
      tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, key, version, status, name, mandatory, channels, variables,
               created_at AS "createdAt", activated_at AS "activatedAt"
          FROM notify.templates ORDER BY key, version DESC`);
  }

  async getTemplate(tenantId: string, templateId: string): Promise<Record<string, unknown> | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, key, version, status, name, subject_fr AS "subjectFr", subject_en AS "subjectEn",
               body_fr AS "bodyFr", body_en AS "bodyEn", variables, channels, mandatory,
               created_at AS "createdAt", activated_at AS "activatedAt"
          FROM notify.templates WHERE id = ${templateId}::uuid`;
      return rows[0] ?? null;
    });
  }

  // ---------- administration de la file (notify.manage, audité) ----------

  async listDeliveries(
    tenantId: string,
    opts: { status?: string; channel?: string; limit?: number } = {},
  ): Promise<unknown[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const status = opts.status ?? null;
    const channel = opts.channel ?? null;
    return this.prisma.withTenant(tenantId, async (tx) =>
      // Volontairement SANS le contenu rendu (sujet/corps) : l'admin de la file voit des
      // métadonnées, pas les messages des utilisateurs.
      tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT d.id, d.notification_id AS "notificationId", d.channel, d.status,
               d.attempt_count AS "attemptCount", d.max_attempts AS "maxAttempts",
               d.next_attempt_at AS "nextAttemptAt", d.last_error AS "lastError",
               d.sent_at AS "sentAt", d.created_at AS "createdAt",
               n.template_key AS "templateKey", u.email AS "userEmail"
          FROM notify.deliveries d
          JOIN notify.notifications n ON n.tenant_id = d.tenant_id AND n.id = d.notification_id
          JOIN admin.users u ON u.id = n.user_id
         WHERE (${status}::text IS NULL OR d.status = ${status})
           AND (${channel}::text IS NULL OR d.channel = ${channel})
         ORDER BY d.created_at DESC
         LIMIT ${limit}`);
  }

  async listAttempts(tenantId: string, deliveryId: string): Promise<unknown[]> {
    return this.prisma.withTenant(tenantId, async (tx) =>
      tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT attempt_no AS "attemptNo", channel, transport, outcome,
               error_code AS "errorCode", error_message AS "errorMessage", attempted_at AS "attemptedAt"
          FROM notify.delivery_attempts WHERE delivery_id = ${deliveryId}::uuid ORDER BY attempt_no`);
  }

  async cancelDelivery(tenantId: string, actorUserId: string, deliveryId: string): Promise<QueueAdminOutcome> {
    return this.prisma.withTenant<QueueAdminOutcome>(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM notify.deliveries WHERE id = ${deliveryId}::uuid FOR UPDATE`;
      if (rows.length === 0) return { kind: 'not_found' };
      if (rows[0]!.status !== 'pending' && rows[0]!.status !== 'failed') {
        return { kind: 'invalid_state', status: rows[0]!.status };
      }
      await tx.$executeRaw`
        UPDATE notify.deliveries SET status = 'cancelled', next_attempt_at = NULL
         WHERE id = ${deliveryId}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'notify_delivery_cancelled', actorUserId, recordId: deliveryId, module: 'notify',
      });
      return { kind: 'ok', status: 'cancelled' };
    });
  }

  /** Requeue d'une livraison dead_letter/cancelled : compteur remis à zéro, due immédiatement. */
  async requeueDelivery(tenantId: string, actorUserId: string, deliveryId: string): Promise<QueueAdminOutcome> {
    return this.prisma.withTenant<QueueAdminOutcome>(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM notify.deliveries WHERE id = ${deliveryId}::uuid FOR UPDATE`;
      if (rows.length === 0) return { kind: 'not_found' };
      if (rows[0]!.status !== 'dead_letter' && rows[0]!.status !== 'cancelled') {
        return { kind: 'invalid_state', status: rows[0]!.status };
      }
      await tx.$executeRaw`
        UPDATE notify.deliveries
           SET status = 'pending', attempt_count = 0, next_attempt_at = now(), last_error = NULL
         WHERE id = ${deliveryId}::uuid`;
      await auditAuth(tx, tenantId, {
        action: 'notify_delivery_requeued', actorUserId, recordId: deliveryId, module: 'notify',
      });
      return { kind: 'ok', status: 'pending' };
    });
  }
}
