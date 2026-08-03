/**
 * E11.2 — Routes demandes de congés : brouillon/prévisualisation/soumission
 * versionnée, décision (enveloppe E3 : retour synchronisé, application hors
 * décision), retrait, annulation par circuit dédié, reprise idempotente,
 * expiration administrative, justificatifs cloisonnés (consultation journalisée,
 * vérification séparée), files équipe/RH, calendrier d'équipe + export.
 * Les portées réelles vivent dans le service — l'identifiant transmis n'élargit rien.
 */
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException,
  Get, HttpCode, HttpException, NotFoundException, Param, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { LeaveRequestsService } from './requests.service';
import type { TimeOutcome } from './leave-access';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new BadRequestException(`« ${field} » n'est pas un UUID`);
  return v;
}
function optUuid(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return uuid(v, field);
}
function str(body: Record<string, unknown>, field: string, max = 300): string {
  const v = body?.[field];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new BadRequestException(`champ « ${field} » manquant ou invalide`);
  }
  return v;
}
function optStr(body: Record<string, unknown>, field: string, max = 1000): string | undefined {
  const v = body?.[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > max) throw new BadRequestException(`champ « ${field} » invalide`);
  return v;
}
function single(v: string | string[] | undefined, field: string): string | undefined {
  if (Array.isArray(v)) throw new BadRequestException(`paramètre « ${field} » répété`);
  return v;
}
function unwrap<T extends Record<string, unknown>>(out: TimeOutcome<never> | ({ kind: 'ok' } & T)): T {
  switch (out.kind) {
    case 'ok': {
      const { kind: _k, ...rest } = out;
      return rest as unknown as T;
    }
    case 'forbidden': throw new ForbiddenException(out.reason);
    case 'not_found': throw new NotFoundException('ressource introuvable');
    case 'invalid': throw new BadRequestException(out.reason);
    case 'conflict': throw new ConflictException(out.reason);
    default: throw new HttpException('résultat inattendu', 500);
  }
}

@Controller('leave')
@UseGuards(SessionGuard, PermissionsGuard)
export class LeaveRequestsController {
  constructor(private readonly requests: LeaveRequestsService) {}

  // ---------- Cycle de vie ----------

  @Post('requests')
  @HttpCode(201)
  async create(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.requests.create(a.tenantId, a.userId, {
      employeeId: optUuid(b['employeeId'], 'employeeId'),
      typeId: uuid(b['typeId'], 'typeId'),
      startDate: str(b, 'startDate', 10),
      endDate: str(b, 'endDate', 10),
      halfDayStart: b['halfDayStart'] === true,
      halfDayEnd: b['halfDayEnd'] === true,
      hours: typeof b['hours'] === 'number' ? b['hours'] : undefined,
      comment: optStr(b, 'comment'),
      onBehalfReason: optStr(b, 'onBehalfReason', 500),
    }));
  }

  @Post('requests/:id')
  @HttpCode(200)
  async updateDraft(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.requests.updateDraft(a.tenantId, a.userId, uuid(id, 'id'), {
      startDate: optStr(b, 'startDate', 10),
      endDate: optStr(b, 'endDate', 10),
      halfDayStart: typeof b['halfDayStart'] === 'boolean' ? b['halfDayStart'] : undefined,
      halfDayEnd: typeof b['halfDayEnd'] === 'boolean' ? b['halfDayEnd'] : undefined,
      hours: b['hours'] === null ? null : typeof b['hours'] === 'number' ? b['hours'] : undefined,
      comment: b['comment'] === null ? null : optStr(b, 'comment'),
    }));
  }

  @Get('requests/preview/:id')
  async preview(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.requests.preview(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Post('requests/:id/confirm')
  @HttpCode(200)
  async confirm(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.requests.confirm(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Post('requests/:id/submit')
  @HttpCode(200)
  async submit(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.requests.submit(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Post('requests/:id/decide')
  @HttpCode(200)
  async decide(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const action = str(b, 'action', 20);
    if (!['approve', 'reject', 'return'].includes(action)) {
      throw new BadRequestException('action : approve, reject ou return');
    }
    return unwrap(await this.requests.decide(a.tenantId, a.userId, uuid(id, 'id'), {
      action: action as 'approve' | 'reject' | 'return',
      comment: optStr(b, 'comment', 500),
      idempotencyKey: optStr(b, 'idempotencyKey', 120),
    }));
  }

  @Post('requests/:id/withdraw')
  @HttpCode(200)
  async withdraw(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.requests.withdraw(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Post('requests/:id/apply')
  @HttpCode(200)
  async retry(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.requests.retryApplication(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Post('requests/:id/cancel-approved')
  @HttpCode(200)
  async cancelApproved(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.requests.requestCancellation(a.tenantId, a.userId, uuid(id, 'id'), str(b, 'reason', 500)));
  }

  @Post('requests/:id/expire')
  @HttpCode(200)
  @RequirePermission('leave.requests_admin')
  async expire(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.requests.expire(a.tenantId, a.userId, uuid(id, 'id'), str(b, 'reason', 500)));
  }

  // ---------- Consultations ----------

  @Get('requests/mine')
  async mine(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.requests.mine(a.tenantId, a.userId));
  }

  @Get('requests/team')
  async team(@Query() q: Record<string, string | string[]>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.requests.listTeam(a.tenantId, a.userId, {
      scope: 'team', status: single(q['status'], 'status'),
    }));
  }

  @Get('requests/queue')
  async queue(@Query() q: Record<string, string | string[]>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.requests.listTeam(a.tenantId, a.userId, {
      scope: 'admin', status: single(q['status'], 'status'),
      sensitiveOnly: single(q['sensitive'], 'sensitive') === '1',
      retroOnly: single(q['retro'], 'retro') === '1',
      failedOnly: single(q['failed'], 'failed') === '1',
    }));
  }

  @Get('requests/:id')
  async detail(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.requests.detail(a.tenantId, a.userId, uuid(id, 'id')));
  }

  // ---------- Justificatifs ----------

  @Post('requests/:id/attachments')
  @HttpCode(201)
  async addAttachment(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.requests.addAttachment(a.tenantId, a.userId, uuid(id, 'id'), {
      filename: str(b, 'filename', 200),
      mime: str(b, 'mime', 50),
      contentBase64: str(b, 'contentBase64', 7_000_000),
    }));
  }

  @Get('requests/attachments/:id')
  async attachment(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.requests.downloadAttachment(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Post('requests/attachments/:id/verify')
  @HttpCode(200)
  @RequirePermission('leave.attachments_verify')
  async verifyAttachment(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const status = str(b, 'status', 10);
    if (status !== 'accepted' && status !== 'rejected') throw new BadRequestException('status : accepted ou rejected');
    return unwrap(await this.requests.verifyAttachment(a.tenantId, a.userId, uuid(id, 'id'), status));
  }

  // ---------- Calendrier d'équipe ----------

  @Get('calendar')
  async calendar(@Query() q: Record<string, string | string[]>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const from = single(q['from'], 'from');
    const to = single(q['to'], 'to');
    if (!from || !to) throw new BadRequestException('from et to requis (AAAA-MM-JJ)');
    return unwrap(await this.requests.calendar(a.tenantId, a.userId, {
      from, to,
      companyId: optUuid(single(q['companyId'], 'companyId'), 'companyId'),
      siteId: optUuid(single(q['siteId'], 'siteId'), 'siteId'),
      unitId: optUuid(single(q['unitId'], 'unitId'), 'unitId'),
    }));
  }

  @Get('calendar/export')
  @RequirePermission('leave.calendar_export')
  async exportCalendar(@Query() q: Record<string, string | string[]>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const from = single(q['from'], 'from');
    const to = single(q['to'], 'to');
    if (!from || !to) throw new BadRequestException('from et to requis (AAAA-MM-JJ)');
    return unwrap(await this.requests.exportCalendar(a.tenantId, a.userId, {
      from, to,
      companyId: optUuid(single(q['companyId'], 'companyId'), 'companyId'),
      siteId: optUuid(single(q['siteId'], 'siteId'), 'siteId'),
      unitId: optUuid(single(q['unitId'], 'unitId'), 'unitId'),
    }));
  }
}
