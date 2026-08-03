/**
 * E10.3 — Routes : demandes de correction (création, soumission, décision,
 * application, annulation, pièces), import contrôlé, anomalies (affectation,
 * balayage d'échéances), périodes (cycle, pré-clôture, clôture, réouverture),
 * préparation paie (variables, empreinte, comparaison, exports).
 * Les opérations de niveau tenant portent une garde déclarative ; toutes les
 * consultations et actions à périmètre passent par les portées réelles du service.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
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
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CorrectionsService } from './corrections.service';
import { PeriodsService } from './periods.service';
import type { TimeOutcome } from './time-access';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new BadRequestException(`« ${field} » n'est pas un UUID`);
  return v;
}
function optUuid(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return uuid(v, field);
}
function str(body: Record<string, unknown>, field: string, max = 500): string {
  const v = body?.[field];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new BadRequestException(`champ « ${field} » manquant ou invalide`);
  }
  return v;
}
function optStr(body: Record<string, unknown>, field: string, max = 500): string | undefined {
  const v = body?.[field];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) throw new BadRequestException(`champ « ${field} » invalide`);
  return v;
}
function obj(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const v = body?.[field];
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new BadRequestException(`champ « ${field} » : objet attendu`);
  return v as Record<string, unknown>;
}
function single(v: string | string[] | undefined, field: string): string | undefined {
  if (Array.isArray(v)) throw new BadRequestException(`paramètre « ${field} » répété`);
  return v;
}
function num(v: string | string[] | undefined, field: string): number | undefined {
  const s = single(v, field);
  if (s === undefined || s === '') return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new BadRequestException(`paramètre « ${field} » numérique`);
  return n;
}
function unwrap<T extends Record<string, unknown>>(out: TimeOutcome<never> | ({ kind: 'ok' } & T)): T {
  switch (out.kind) {
    case 'ok': {
      const { kind: _k, ...rest } = out;
      return rest as unknown as T;
    }
    case 'forbidden': throw new ForbiddenException(out.reason);
    case 'not_found': throw new HttpException('ressource introuvable', 404);
    case 'invalid': throw new BadRequestException(out.reason);
    case 'conflict': throw new ConflictException(out.reason);
    default: throw new BadRequestException('requête invalide');
  }
}

@Controller('time')
@UseGuards(SessionGuard, PermissionsGuard)
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Post('corrections')
  @HttpCode(201)
  async create(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.corrections.create(a.tenantId, a.userId, {
      employeeId: optUuid(b['employeeId'], 'employeeId'),
      workDate: str(b, 'workDate', 10),
      kind: str(b, 'kind', 40),
      motive: str(b, 'motive', 500),
      payload: obj(b, 'payload'),
      anomalyId: optUuid(b['anomalyId'], 'anomalyId'),
    }));
  }

  @Post('corrections/:id/submit')
  @HttpCode(200)
  async submit(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.corrections.submit(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Post('corrections/:id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.corrections.cancel(a.tenantId, a.userId, uuid(id, 'id')));
  }

  /** Décision via le circuit E3 — approbation finale ⇒ application automatique. */
  @Post('corrections/:id/decide')
  @HttpCode(200)
  async decide(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const action = str(b, 'action', 10);
    if (action !== 'approve' && action !== 'reject' && action !== 'return') {
      throw new BadRequestException('action : approve, reject ou return');
    }
    return unwrap(await this.corrections.decide(a.tenantId, a.userId, uuid(id, 'id'), {
      action, comment: optStr(b, 'comment', 300), idempotencyKey: optStr(b, 'idempotencyKey', 100),
    }));
  }

  /** Relance d'application (approved / application_failed) — administration. */
  @Post('corrections/:id/apply')
  @HttpCode(200)
  @RequirePermission('time.correction_admin')
  async apply(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.corrections.applyApproved(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Get('corrections/mine')
  async mine(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.corrections.listMine(a.tenantId, a.userId, { limit: num(q['limit'], 'limit') }));
  }

  @Get('corrections')
  async list(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.corrections.list(a.tenantId, a.userId, {
      status: single(q['status'], 'status'),
      employeeId: optUuid(single(q['employeeId'], 'employeeId'), 'employeeId'),
      from: single(q['from'], 'from'), to: single(q['to'], 'to'),
      limit: num(q['limit'], 'limit'), offset: num(q['offset'], 'offset'),
    }));
  }

  @Get('corrections/:id')
  async detail(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.corrections.detail(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Post('corrections/:id/attachments')
  @HttpCode(201)
  async addAttachment(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.corrections.addAttachment(a.tenantId, a.userId, uuid(id, 'id'), {
      filename: str(b, 'filename', 200),
      mime: str(b, 'mime', 50),
      contentBase64: str(b, 'contentBase64', 7_000_000),
      sensitive: b['sensitive'] === true,
    }));
  }

  @Get('corrections/attachments/:id')
  async attachment(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.corrections.downloadAttachment(a.tenantId, a.userId, uuid(id, 'id')));
  }

  /** Import CONTRÔLÉ de corrections historiques — administration, borné, audité. */
  @Post('corrections/import')
  @HttpCode(200)
  @RequirePermission('time.correction_admin')
  async importHistorical(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const rows = b?.['rows'];
    if (!Array.isArray(rows)) throw new BadRequestException('rows : tableau requis');
    return unwrap(await this.corrections.importHistorical(a.tenantId, a.userId,
      rows.map((r) => {
        const rec = (r ?? {}) as Record<string, unknown>;
        return {
          employeeId: uuid(rec['employeeId'], 'rows[].employeeId'),
          workDate: str(rec, 'workDate', 10),
          kind: str(rec, 'kind', 40),
          motive: str(rec, 'motive', 400),
          payload: obj(rec, 'payload'),
        };
      })));
  }

  /** Balayage des échéances d'anomalies (notifications) — opération d'administration. */
  @Post('anomalies/sweep')
  @HttpCode(200)
  async sweep(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.corrections.sweepAnomalies(a.tenantId, a.userId));
  }
}

@Controller('time')
@UseGuards(SessionGuard, PermissionsGuard)
export class PeriodsController {
  constructor(private readonly periods: PeriodsService) {}

  @Post('periods')
  @HttpCode(201)
  @RequirePermission('time.period_manage')
  async create(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.periods.create(a.tenantId, a.userId, {
      scopeKind: str(b, 'scopeKind', 10),
      companyId: optUuid(b['companyId'], 'companyId'),
      siteId: optUuid(b['siteId'], 'siteId'),
      label: str(b, 'label', 100),
      periodStart: str(b, 'periodStart', 10),
      periodEnd: str(b, 'periodEnd', 10),
    }));
  }

  @Get('periods')
  async list(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.periods.list(a.tenantId, a.userId));
  }

  @Post('periods/:id/status')
  @HttpCode(200)
  @RequirePermission('time.period_manage')
  async setStatus(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.periods.setStatus(a.tenantId, a.userId, uuid(id, 'id'), str(b, 'status', 12)));
  }

  @Get('periods/:id/preclose')
  async preclose(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.periods.preclose(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Post('periods/:id/close')
  @HttpCode(201)
  @RequirePermission('time.period_close')
  async close(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.periods.close(a.tenantId, a.userId, uuid(id, 'id'), {
      confirmWarnings: b?.['confirmWarnings'] === true,
    }));
  }

  @Post('periods/:id/reopen')
  @HttpCode(200)
  @RequirePermission('time.period_reopen')
  async reopen(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.periods.reopen(a.tenantId, a.userId, uuid(id, 'id'), str(b, 'motive', 300)));
  }

  @Get('periods/:id/closes')
  async closes(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.periods.listCloses(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Get('closes/:id/payroll')
  async payroll(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.periods.payroll(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Get('closes/:id/verify')
  async verify(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.periods.verify(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Get('closes/:id/compare')
  async compare(@Param('id') id: string, @Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const withId = single(q['with'], 'with');
    if (!withId) throw new BadRequestException('paramètre « with » requis (clôture à comparer)');
    return unwrap(await this.periods.compare(a.tenantId, a.userId, uuid(id, 'id'), uuid(withId, 'with')));
  }

  @Post('closes/:id/exports')
  @HttpCode(201)
  @RequirePermission('time.payroll_export')
  async generateExport(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const format = str(b, 'format', 5);
    if (format !== 'csv' && format !== 'json') throw new BadRequestException('format : csv ou json');
    return unwrap(await this.periods.generateExport(a.tenantId, a.userId, uuid(id, 'id'), format));
  }

  @Get('closes/:id/exports')
  async listExports(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.periods.listExports(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Get('payroll-exports/:id/download')
  @RequirePermission('time.payroll_export')
  async download(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.periods.downloadExport(a.tenantId, a.userId, uuid(id, 'id')));
  }
}
