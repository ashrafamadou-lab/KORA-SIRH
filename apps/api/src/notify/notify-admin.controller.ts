import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  NotificationService,
  type PublishOutcome,
  type QueueAdminOutcome,
  type RecipientSpec,
  type TemplateOutcome,
} from './notification.service';
import type { NotifyChannel } from '../../../../packages/core/src/notify.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(v: string, field: string): string {
  if (!UUID_RE.test(v)) throw new BadRequestException(`« ${field} » n'est pas un UUID`);
  return v;
}

function str(body: Record<string, unknown>, field: string, max = 4000): string {
  const v = body?.[field];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new BadRequestException(`champ « ${field} » manquant ou invalide`);
  }
  return v;
}

function templateBody(body: Record<string, unknown>) {
  return {
    name: str(body, 'name', 200),
    subjectFr: str(body, 'subjectFr', 200),
    subjectEn: str(body, 'subjectEn', 200),
    bodyFr: str(body, 'bodyFr', 4000),
    bodyEn: str(body, 'bodyEn', 4000),
    variables: Array.isArray(body?.['variables']) ? (body['variables'] as string[]) : [],
    channels: Array.isArray(body?.['channels']) ? (body['channels'] as NotifyChannel[]) : (['in_app'] as NotifyChannel[]),
    mandatory: body?.['mandatory'] === true,
  };
}

function templateToHttp(outcome: TemplateOutcome): { id: string; version: number } {
  switch (outcome.kind) {
    case 'ok':
      return { id: outcome.id, version: outcome.version };
    case 'invalid':
      throw new BadRequestException(outcome.issues.join(' ; '));
    case 'not_found':
      throw new HttpException('modèle introuvable', 404);
    case 'not_draft':
      throw new BadRequestException('seul un modèle draft est modifiable/activable');
  }
}

function queueToHttp(outcome: QueueAdminOutcome): { status: string } {
  switch (outcome.kind) {
    case 'ok':
      return { status: outcome.status };
    case 'not_found':
      throw new HttpException('livraison introuvable', 404);
    case 'invalid_state':
      throw new BadRequestException(`état incompatible : ${outcome.status}`);
  }
}

/** Parse les destinataires d'une publication métier : userId, roleKey ou portée. */
function parseRecipients(raw: unknown): RecipientSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BadRequestException('recipients : liste non vide requise');
  }
  if (raw.length > 50) throw new BadRequestException('recipients : 50 spécifications maximum');
  return raw.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o['userId'] === 'string') return { userId: uuid(o['userId'], `recipients[${i}].userId`) };
    if (typeof o['roleKey'] === 'string' && o['roleKey'].length > 0 && o['roleKey'].length <= 100) {
      return { roleKey: o['roleKey'] };
    }
    if (typeof o['scopeType'] === 'string') {
      const ref = o['scopeRef'];
      return {
        scopeType: o['scopeType'],
        scopeRef: typeof ref === 'string' ? uuid(ref, `recipients[${i}].scopeRef`) : null,
      };
    }
    throw new BadRequestException(`recipients[${i}] : userId, roleKey ou scopeType requis`);
  });
}

/** Administration des notifications (notify.manage) : modèles, publication, file. Tout est audité. */
@Controller('admin/notify')
@UseGuards(SessionGuard, PermissionsGuard)
export class NotifyAdminController {
  constructor(private readonly notify: NotificationService) {}

  // ---------- Modèles ----------

  @Post('templates')
  @HttpCode(201)
  @RequirePermission('notify.manage')
  async createTemplate(@Body() body: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return templateToHttp(await this.notify.createTemplate(a.tenantId, a.userId, {
      key: str(body, 'key', 100),
      ...templateBody(body),
    }));
  }

  @Get('templates')
  @RequirePermission('notify.manage')
  listTemplates(@Req() req: AuthenticatedRequest): Promise<unknown> {
    return this.notify.listTemplates(req.authCtx!.tenantId);
  }

  @Get('templates/:id')
  @RequirePermission('notify.manage')
  async getTemplate(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<unknown> {
    const tpl = await this.notify.getTemplate(req.authCtx!.tenantId, uuid(id, 'id'));
    if (!tpl) throw new HttpException('modèle introuvable', 404);
    return tpl;
  }

  @Patch('templates/:id')
  @HttpCode(200)
  @RequirePermission('notify.manage')
  async updateTemplate(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ) {
    const a = req.authCtx!;
    return templateToHttp(await this.notify.updateTemplate(a.tenantId, a.userId, uuid(id, 'id'), templateBody(body)));
  }

  @Post('templates/:id/activate')
  @HttpCode(200)
  @RequirePermission('notify.manage')
  async activateTemplate(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return templateToHttp(await this.notify.activateTemplate(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Post('templates/:id/retire')
  @HttpCode(200)
  @RequirePermission('notify.manage')
  async retireTemplate(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<{ retired: true }> {
    const a = req.authCtx!;
    const outcome = await this.notify.retireTemplate(a.tenantId, a.userId, uuid(id, 'id'));
    if (outcome.kind === 'not_found') throw new HttpException('modèle introuvable ou déjà retiré', 404);
    return { retired: true };
  }

  // ---------- Publication d'un événement métier ----------

  @Post('events')
  @HttpCode(201)
  @RequirePermission('notify.manage')
  async publish(@Body() body: Record<string, unknown>, @Req() req: AuthenticatedRequest): Promise<unknown> {
    const a = req.authCtx!;
    const payload = (body?.['payload'] ?? {}) as Record<string, unknown>;
    if (typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestException('payload : objet requis');
    }
    const outcome: PublishOutcome = await this.notify.publishEvent(a.tenantId, {
      eventKey: str(body, 'eventKey', 200),
      templateKey: str(body, 'templateKey', 100),
      payload,
      recipients: parseRecipients(body?.['recipients']),
      source: 'business',
      createdBy: a.userId,
    });
    switch (outcome.kind) {
      case 'published':
        return { eventId: outcome.eventId, duplicate: false, recipients: outcome.recipients, inApp: outcome.inApp, queued: outcome.queued };
      case 'duplicate':
        // Idempotence assumée : rejouer le même événement est un succès sans effet.
        return { eventId: outcome.eventId, duplicate: true, recipients: 0, inApp: 0, queued: 0 };
      case 'no_template':
        throw new HttpException('aucun modèle actif pour cette clé', 404);
      case 'invalid_variables':
        throw new BadRequestException(
          `variables invalides — manquantes : [${outcome.missing.join(', ')}] ; inconnues : [${outcome.unknown.join(', ')}]`);
      case 'unsafe_variables':
        throw new BadRequestException(
          `variables refusées (sécurité) : ${outcome.violations.map((v) => `${v.name} (${v.reason})`).join(' ; ')}`);
      case 'invalid':
        throw new BadRequestException(outcome.reason);
    }
  }

  // ---------- File de livraison ----------

  @Get('queue')
  @RequirePermission('notify.manage')
  listQueue(
    @Req() req: AuthenticatedRequest,
    @Query('status') status?: string,
    @Query('channel') channel?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    return this.notify.listDeliveries(req.authCtx!.tenantId, {
      status, channel, limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('deliveries/:id/attempts')
  @RequirePermission('notify.manage')
  listAttempts(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<unknown> {
    return this.notify.listAttempts(req.authCtx!.tenantId, uuid(id, 'id'));
  }

  @Post('queue/process')
  @HttpCode(200)
  @RequirePermission('notify.manage')
  processQueue(@Body() body: Record<string, unknown>, @Req() req: AuthenticatedRequest): Promise<unknown> {
    const limit = typeof body?.['limit'] === 'number' ? (body['limit'] as number) : undefined;
    return this.notify.processQueue(req.authCtx!.tenantId, { limit });
  }

  @Post('deliveries/:id/cancel')
  @HttpCode(200)
  @RequirePermission('notify.manage')
  async cancelDelivery(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return queueToHttp(await this.notify.cancelDelivery(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Post('deliveries/:id/requeue')
  @HttpCode(200)
  @RequirePermission('notify.manage')
  async requeueDelivery(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return queueToHttp(await this.notify.requeueDelivery(a.tenantId, a.userId, uuid(id, 'id')));
  }
}
