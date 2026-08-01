import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { NotificationService } from './notification.service';
import type { OutboundChannel } from '../../../../packages/core/src/notify.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(v: string, field: string): string {
  if (!UUID_RE.test(v)) throw new BadRequestException(`« ${field} » n'est pas un UUID`);
  return v;
}

/**
 * Self-service notifications : TOUJOURS borné à l'utilisateur de la session (en plus de
 * la RLS tenant). Une notification d'un autre utilisateur — même du même tenant — est
 * introuvable (404), jamais interdite (403) : aucune existence n'est révélée.
 */
@Controller('notifications')
@UseGuards(SessionGuard)
export class NotifyController {
  constructor(private readonly notify: NotificationService) {}

  // NB : routes statiques déclarées AVANT ':id'.

  @Get('preferences')
  getPreferences(@Req() req: AuthenticatedRequest): Promise<unknown> {
    const a = req.authCtx!;
    return this.notify.getPreferences(a.tenantId, a.userId);
  }

  @Put('preferences')
  @HttpCode(200)
  async setPreferences(
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ): Promise<unknown> {
    const a = req.authCtx!;
    const outcome = await this.notify.setPreferences(a.tenantId, a.userId, {
      locale: body?.['locale'],
      channels: (body?.['channels'] ?? undefined) as Partial<Record<OutboundChannel, unknown>> | undefined,
    });
    if (outcome.kind === 'invalid') throw new BadRequestException(outcome.reason);
    return this.notify.getPreferences(a.tenantId, a.userId);
  }

  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query('unread') unread?: string,
    @Query('includeArchived') includeArchived?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<unknown> {
    const a = req.authCtx!;
    return this.notify.listMine(a.tenantId, a.userId, {
      unreadOnly: unread === '1' || unread === 'true',
      includeArchived: includeArchived === '1' || includeArchived === 'true',
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<unknown> {
    const a = req.authCtx!;
    const notif = await this.notify.getMine(a.tenantId, a.userId, uuid(id, 'id'));
    if (!notif) throw new HttpException('notification introuvable', 404);
    return notif;
  }

  @Post(':id/read')
  @HttpCode(200)
  async markRead(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<{ read: true }> {
    const a = req.authCtx!;
    const outcome = await this.notify.markRead(a.tenantId, a.userId, uuid(id, 'id'));
    if (outcome.kind === 'not_found') throw new HttpException('notification introuvable', 404);
    return { read: true };
  }

  @Post(':id/archive')
  @HttpCode(200)
  async archive(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<{ archived: true }> {
    const a = req.authCtx!;
    const outcome = await this.notify.archive(a.tenantId, a.userId, uuid(id, 'id'));
    if (outcome.kind === 'not_found') throw new HttpException('notification introuvable', 404);
    return { archived: true };
  }
}
