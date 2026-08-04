/**
 * E11.3 — Routes : périodes de congés, pré-clôture, clôture (empreinte
 * reproductible), vérification, réouverture par circuit, exports préparatoires
 * paie (sans montant, idempotents, immuables, téléchargement audité),
 * intégration présence (suivi + reprise), reporting agrégé borné aux portées.
 */
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException,
  Get, HttpCode, HttpException, NotFoundException, Param, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { LeaveCloseService } from './close.service';
import { LeaveIntegrationService } from './integration.service';
import type { TimeOutcome } from './leave-access';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new BadRequestException(`« ${field} » n'est pas un UUID`);
  return v;
}
function str(body: Record<string, unknown>, field: string, max = 300): string {
  const v = body?.[field];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new BadRequestException(`champ « ${field} » manquant ou invalide`);
  }
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
export class LeaveCloseController {
  constructor(
    private readonly closes: LeaveCloseService,
    private readonly integration: LeaveIntegrationService,
  ) {}

  // ---------- Périodes & clôture ----------

  @Post('periods')
  @HttpCode(201)
  @RequirePermission('leave.period_manage')
  async createPeriod(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.closes.createPeriod(a.tenantId, a.userId, {
      label: str(b, 'label', 100), periodStart: str(b, 'periodStart', 10), periodEnd: str(b, 'periodEnd', 10),
    }));
  }

  @Get('periods')
  async listPeriods(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.closes.listPeriods(a.tenantId, a.userId));
  }

  @Get('periods/:id/preclose')
  async preclose(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.closes.preclose(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Post('periods/:id/close')
  @HttpCode(200)
  @RequirePermission('leave.close_run')
  async close(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.closes.close(a.tenantId, a.userId, uuid(id, 'id'), {
      confirmWarnings: b['confirmWarnings'] === true,
    }));
  }

  @Post('periods/:id/reopen')
  @HttpCode(200)
  @RequirePermission('leave.reopen')
  async reopen(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.closes.requestReopen(a.tenantId, a.userId, uuid(id, 'id'), str(b, 'reason', 500)));
  }

  @Get('periods/:id/closes')
  async listCloses(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.closes.listCloses(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Get('closes/:id/verify')
  async verify(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.closes.verify(a.tenantId, a.userId, uuid(id, 'id')));
  }

  // ---------- Exports préparatoires paie ----------

  @Post('closes/:id/exports')
  @HttpCode(201)
  @RequirePermission('leave.export_create')
  async createExport(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const format = str(b, 'format', 5);
    if (format !== 'csv' && format !== 'json') throw new BadRequestException('format : csv ou json');
    return unwrap(await this.closes.createExport(a.tenantId, a.userId, uuid(id, 'id'), format));
  }

  @Get('closes/:id/exports')
  async listExports(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.closes.listExports(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Get('prep-exports/:id/download')
  @RequirePermission('leave.export_download')
  async download(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.closes.downloadExport(a.tenantId, a.userId, uuid(id, 'id')));
  }

  // ---------- Intégration présence ----------

  @Get('integration')
  async integrationStatus(@Query() q: Record<string, string | string[]>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const from = single(q['from'], 'from');
    const to = single(q['to'], 'to');
    if (!from || !to) throw new BadRequestException('from et to requis (AAAA-MM-JJ)');
    return unwrap(await this.integration.status(a.tenantId, a.userId, { from, to }));
  }

  @Post('integration/run')
  @HttpCode(200)
  @RequirePermission('leave.integration_run')
  async integrationRun(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const employeeId = typeof b['employeeId'] === 'string' && b['employeeId'] !== '' ? uuid(b['employeeId'], 'employeeId') : undefined;
    return unwrap(await this.integration.runIntegration(a.tenantId, a.userId, {
      from: str(b, 'from', 10), to: str(b, 'to', 10), employeeId,
    }));
  }

  // ---------- Reporting ----------

  @Get('reports')
  async report(@Query() q: Record<string, string | string[]>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const from = single(q['from'], 'from');
    const to = single(q['to'], 'to');
    if (!from || !to) throw new BadRequestException('from et to requis (AAAA-MM-JJ)');
    return unwrap(await this.closes.report(a.tenantId, a.userId, { from, to }));
  }
}
