import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  WorkflowService,
  type ActOutcome,
  type ActorIdentity,
} from './workflow.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(v: string, field: string): string {
  if (!UUID_RE.test(v)) throw new BadRequestException(`« ${field} » n'est pas un UUID`);
  return v;
}

/** Traduit un résultat d'action en réponse HTTP — les refus deviennent des exceptions. */
function actToHttp(outcome: ActOutcome): { status: string; currentStepIndex: number | null; transitionSeq: number } {
  switch (outcome.kind) {
    case 'ok':
      return { status: outcome.status, currentStepIndex: outcome.currentStepIndex, transitionSeq: outcome.transitionSeq };
    case 'not_found':
      throw new HttpException('instance introuvable', 404);
    case 'stale':
      throw new HttpException({ statusCode: 409, message: 'instance déjà avancée', code: 'stale' }, 409);
    case 'forbidden':
      throw new ForbiddenException(outcome.reason);
    case 'invalid':
      throw new BadRequestException(outcome.reason);
  }
}

@Controller('workflow')
@UseGuards(SessionGuard, PermissionsGuard)
export class WorkflowController {
  constructor(
    private readonly wf: WorkflowService,
    private readonly prisma: PrismaService,
  ) {}

  // ---------- Définitions (workflow.manage) ----------

  @Post('definitions')
  @HttpCode(201)
  @RequirePermission('workflow.manage')
  async createDefinition(
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ id: string; version: number }> {
    const a = req.authCtx!;
    const outcome = await this.wf.createDefinition(a.tenantId, a.userId, {
      key: String(body?.['key'] ?? ''),
      name: String(body?.['name'] ?? ''),
      steps: (body?.['steps'] ?? []) as never,
    });
    if (outcome.kind === 'invalid') throw new BadRequestException(outcome.reason);
    return { id: outcome.id, version: outcome.version };
  }

  @Post('definitions/:id/activate')
  @HttpCode(200)
  @RequirePermission('workflow.manage')
  async activate(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<{ active: true }> {
    const a = req.authCtx!;
    const outcome = await this.wf.activateDefinition(a.tenantId, a.userId, uuid(id, 'id'));
    if (outcome.kind === 'not_found') throw new HttpException('définition introuvable', 404);
    if (outcome.kind === 'not_draft') throw new BadRequestException('seule une définition draft peut être activée');
    return { active: true };
  }

  // ---------- Instances ----------

  @Post('instances')
  @HttpCode(201)
  @RequirePermission('workflow.submit')
  async submit(
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ instanceId: string; status: string; currentStepIndex: number | null }> {
    const a = req.authCtx!;
    const key = String(body?.['definitionKey'] ?? '');
    const subjectType = String(body?.['subjectType'] ?? '');
    const subjectId = uuid(String(body?.['subjectId'] ?? ''), 'subjectId');
    if (!key || !subjectType) throw new BadRequestException('definitionKey et subjectType requis');
    const context = (body?.['context'] ?? {}) as Record<string, unknown>;
    const outcome = await this.wf.submit(a.tenantId, a.userId, { definitionKey: key, subjectType, subjectId, context });
    if (outcome.kind === 'no_active_definition') throw new HttpException('aucune définition active pour cette clé', 404);
    if (outcome.kind === 'empty_workflow') throw new BadRequestException('aucune étape applicable au contexte');
    return { instanceId: outcome.instanceId, status: outcome.status, currentStepIndex: outcome.currentStepIndex };
  }

  /** Boîtes de travail (E7) : inbox = à décider par MOI ; outbox = mes demandes. */
  @Get('instances')
  @RequirePermission('workflow.view')
  async listInstances(
    @Query('box') box: string | undefined,
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: unknown[]; box: string }> {
    const a = req.authCtx!;
    const b = box ?? 'inbox';
    if (b !== 'inbox' && b !== 'outbox') throw new BadRequestException('box : inbox ou outbox');
    if (status !== undefined && !['pending', 'approved', 'rejected', 'returned', 'cancelled', 'expired'].includes(status)) {
      throw new BadRequestException('status inconnu');
    }
    const lim = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 200);
    const off = Math.max(Number(offset ?? 0) || 0, 0);
    const items = await this.wf.listInstances(a.tenantId, await this.actor(req), {
      box: b, status, limit: lim, offset: off,
    });
    return { items, box: b };
  }

  @Get('instances/:id')
  @RequirePermission('workflow.view')
  async getInstance(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<unknown> {
    const a = req.authCtx!;
    return this.prisma.withTenant(a.tenantId, async (tx) => {
      const inst = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT id, definition_key AS "definitionKey", definition_version AS "definitionVersion",
               status, current_step_index AS "currentStepIndex", revision, context,
               subject_type AS "subjectType", subject_id AS "subjectId", created_by AS "createdBy"
          FROM workflow.instances WHERE id = ${uuid(id, 'id')}::uuid`;
      if (inst.length === 0) throw new HttpException('instance introuvable', 404);
      const transitions = await tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT seq, action, from_status AS "fromStatus", to_status AS "toStatus",
               step_index AS "stepIndex", actor_user_id AS "actorUserId", on_behalf_of AS "onBehalfOf",
               comment, occurred_at AS "occurredAt"
          FROM workflow.transitions WHERE instance_id = ${uuid(id, 'id')}::uuid ORDER BY seq`;
      return { ...inst[0], history: transitions };
    });
  }

  // ---------- Actions (workflow.act) ----------

  @Post('instances/:id/approve')
  @HttpCode(200)
  @RequirePermission('workflow.act')
  async approve(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    return actToHttp(await this.wf.decide(req.authCtx!.tenantId, await this.actor(req), uuid(id, 'id'), 'approve', this.actOpts(body)));
  }

  @Post('instances/:id/reject')
  @HttpCode(200)
  @RequirePermission('workflow.act')
  async reject(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    return actToHttp(await this.wf.decide(req.authCtx!.tenantId, await this.actor(req), uuid(id, 'id'), 'reject', this.actOpts(body)));
  }

  @Post('instances/:id/return')
  @HttpCode(200)
  @RequirePermission('workflow.act')
  async returnToRequester(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    return actToHttp(await this.wf.decide(req.authCtx!.tenantId, await this.actor(req), uuid(id, 'id'), 'return', this.actOpts(body)));
  }

  @Post('instances/:id/cancel')
  @HttpCode(200)
  @RequirePermission('workflow.act')
  async cancel(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    return actToHttp(await this.wf.cancel(req.authCtx!.tenantId, await this.actor(req), uuid(id, 'id'), this.actOpts(body)));
  }

  @Post('instances/:id/delegate')
  @HttpCode(200)
  @RequirePermission('workflow.act')
  async delegate(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const toUserId = uuid(String(body?.['toUserId'] ?? ''), 'toUserId');
    return actToHttp(await this.wf.delegate(req.authCtx!.tenantId, await this.actor(req), uuid(id, 'id'), toUserId, this.actOpts(body)));
  }

  @Post('tick')
  @HttpCode(200)
  @RequirePermission('workflow.manage')
  async tick(@Req() req: AuthenticatedRequest): Promise<{ reminded: number; escalated: number }> {
    return this.wf.tick(req.authCtx!.tenantId);
  }

  // ---------- privé ----------

  private actOpts(body: Record<string, unknown>) {
    const opts: { comment?: string; attachments?: unknown; idempotencyKey?: string; expectedRevision?: number } = {};
    if (typeof body?.['comment'] === 'string') opts.comment = body['comment'] as string;
    if (body?.['attachments'] !== undefined) opts.attachments = body['attachments'];
    if (typeof body?.['idempotencyKey'] === 'string') opts.idempotencyKey = body['idempotencyKey'] as string;
    if (typeof body?.['expectedRevision'] === 'number') opts.expectedRevision = body['expectedRevision'] as number;
    return opts;
  }

  /** Charge les rôles et portées de l'acteur pour la résolution d'assignation d'étape. */
  private async actor(req: AuthenticatedRequest): Promise<ActorIdentity> {
    const a = req.authCtx!;
    return this.prisma.withTenant(a.tenantId, async (tx) => {
      const roles = await tx.$queryRaw<Array<{ key: string }>>`
        SELECT r.key FROM admin.user_roles ur JOIN admin.roles r ON r.id = ur.role_id
         WHERE ur.user_id = ${a.userId}::uuid`;
      const scopes = await tx.$queryRaw<Array<{ scope_type: string; scope_ref: string | null }>>`
        SELECT scope_type, scope_ref FROM admin.user_scopes WHERE user_id = ${a.userId}::uuid`;
      return {
        userId: a.userId,
        roleKeys: roles.map((r) => r.key),
        scopes: scopes.map((s) => ({ type: s.scope_type, ref: s.scope_ref })),
      };
    });
  }
}
