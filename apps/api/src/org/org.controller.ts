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
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { OrgService, type CreateOutcome, type MoveOutcome, type OrgEntity, type StatusOutcome } from './org.service';
import { OrgImportService } from './org-import.service';
import type { OrgStatus } from '../../../../packages/core/src/org.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function uuid(v: unknown, field: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new BadRequestException(`« ${field} » n'est pas un UUID`);
  return v;
}
function optUuid(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return uuid(v, field);
}
function str(body: Record<string, unknown>, field: string, max = 200): string {
  const v = body?.[field];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new BadRequestException(`champ « ${field} » manquant ou invalide`);
  }
  return v;
}
function optStr(body: Record<string, unknown>, field: string, max = 200): string | undefined {
  const v = body?.[field];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) throw new BadRequestException(`champ « ${field} » invalide`);
  return v;
}
function dateOrToday(v: unknown, field: string): string {
  if (v === undefined || v === null || v === '') return new Date().toISOString().slice(0, 10);
  if (typeof v !== 'string' || !DATE_RE.test(v)) throw new BadRequestException(`« ${field} » : AAAA-MM-JJ`);
  return v;
}

function createToHttp(outcome: CreateOutcome): { id: string } {
  switch (outcome.kind) {
    case 'ok': return { id: outcome.id };
    case 'invalid': throw new BadRequestException(outcome.reason);
    case 'duplicate_code': throw new HttpException({ statusCode: 409, message: 'code déjà utilisé dans ce tenant', code: 'duplicate_code' }, 409);
    case 'ref_not_found': throw new BadRequestException(`référence introuvable : ${outcome.ref}`);
  }
}

const ENTITIES: Record<string, OrgEntity> = {
  companies: 'company', sites: 'site', 'cost-centers': 'cost_center',
  jobs: 'job', units: 'unit', positions: 'position',
};

/** Référentiel organisationnel (E8) — org.view / org.manage / org.import. */
@Controller('org')
@UseGuards(SessionGuard, PermissionsGuard)
export class OrgController {
  constructor(
    private readonly org: OrgService,
    private readonly orgImport: OrgImportService,
  ) {}

  // ---------------- création (org.manage) ----------------

  @Post('companies')
  @HttpCode(201)
  @RequirePermission('org.manage')
  async createCompany(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return createToHttp(await this.org.createCompany(a.tenantId, a.userId, {
      code: str(b, 'code', 30).toUpperCase(), labelFr: str(b, 'labelFr'), labelEn: str(b, 'labelEn'),
      legalForm: optStr(b, 'legalForm', 100),
    }));
  }

  @Post('sites')
  @HttpCode(201)
  @RequirePermission('org.manage')
  async createSite(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return createToHttp(await this.org.createSite(a.tenantId, a.userId, {
      code: str(b, 'code', 30).toUpperCase(), labelFr: str(b, 'labelFr'), labelEn: str(b, 'labelEn'),
      companyId: uuid(b['companyId'], 'companyId'), city: optStr(b, 'city', 100),
    }));
  }

  @Post('cost-centers')
  @HttpCode(201)
  @RequirePermission('org.manage')
  async createCostCenter(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return createToHttp(await this.org.createCostCenter(a.tenantId, a.userId, {
      code: str(b, 'code', 30).toUpperCase(), labelFr: str(b, 'labelFr'), labelEn: str(b, 'labelEn'),
    }));
  }

  @Post('jobs')
  @HttpCode(201)
  @RequirePermission('org.manage')
  async createJob(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return createToHttp(await this.org.createJob(a.tenantId, a.userId, {
      code: str(b, 'code', 30).toUpperCase(), labelFr: str(b, 'labelFr'), labelEn: str(b, 'labelEn'),
      category: optStr(b, 'category', 100),
    }));
  }

  @Post('units')
  @HttpCode(201)
  @RequirePermission('org.manage')
  async createUnit(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return createToHttp(await this.org.createUnit(a.tenantId, a.userId, {
      code: str(b, 'code', 30).toUpperCase(), labelFr: str(b, 'labelFr'), labelEn: str(b, 'labelEn'),
      unitType: str(b, 'unitType', 20),
      companyId: optUuid(b['companyId'], 'companyId'),
      parentUnitId: optUuid(b['parentUnitId'], 'parentUnitId'),
      effectiveFrom: optStr(b, 'effectiveFrom', 10),
    }));
  }

  @Post('positions')
  @HttpCode(201)
  @RequirePermission('org.manage')
  async createPosition(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return createToHttp(await this.org.createPosition(a.tenantId, a.userId, {
      code: str(b, 'code', 30).toUpperCase(), labelFr: str(b, 'labelFr'), labelEn: str(b, 'labelEn'),
      unitId: uuid(b['unitId'], 'unitId'), companyId: uuid(b['companyId'], 'companyId'),
      jobId: uuid(b['jobId'], 'jobId'),
      siteId: optUuid(b['siteId'], 'siteId'), costCenterId: optUuid(b['costCenterId'], 'costCenterId'),
      managerPositionId: optUuid(b['managerPositionId'], 'managerPositionId'),
      effectiveFrom: optStr(b, 'effectiveFrom', 10),
    }));
  }

  // ---------------- statuts (org.manage) ----------------

  @Post(':entity/:id/status')
  @HttpCode(200)
  @RequirePermission('org.manage')
  async setStatus(
    @Param('entity') entity: string, @Param('id') id: string,
    @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest,
  ) {
    const a = req.authCtx!;
    const mapped = ENTITIES[entity];
    if (!mapped) throw new BadRequestException('entité inconnue');
    const status = str(b, 'status', 10) as OrgStatus;
    if (!['draft', 'active', 'inactive', 'archived'].includes(status)) throw new BadRequestException('statut inconnu');
    const outcome: StatusOutcome = await this.org.setStatus(a.tenantId, a.userId, mapped, uuid(id, 'id'), status);
    switch (outcome.kind) {
      case 'ok': return { status: outcome.status };
      case 'not_found': throw new HttpException('introuvable', 404);
      case 'invalid_transition': throw new BadRequestException(`transition interdite depuis « ${outcome.from} »`);
      case 'children_active':
        throw new HttpException({
          statusCode: 409, code: 'children_active',
          message: `unité avec dépendances actives (${outcome.units} unité(s), ${outcome.positions} poste(s)) : traiter les enfants d'abord — aucun orphelin`,
        }, 409);
    }
  }

  // ---------------- consultation (org.view) ----------------

  @Get('companies')
  @RequirePermission('org.view')
  listCompanies(@Query() q: Record<string, string | undefined>, @Req() req: AuthenticatedRequest) {
    return this.org.listSimple(req.authCtx!.tenantId, 'company', this.listOpts(q));
  }

  @Get('sites')
  @RequirePermission('org.view')
  listSites(@Query() q: Record<string, string | undefined>, @Req() req: AuthenticatedRequest) {
    return this.org.listSimple(req.authCtx!.tenantId, 'site', this.listOpts(q));
  }

  @Get('cost-centers')
  @RequirePermission('org.view')
  listCostCenters(@Query() q: Record<string, string | undefined>, @Req() req: AuthenticatedRequest) {
    return this.org.listSimple(req.authCtx!.tenantId, 'cost_center', this.listOpts(q));
  }

  @Get('jobs')
  @RequirePermission('org.view')
  listJobs(@Query() q: Record<string, string | undefined>, @Req() req: AuthenticatedRequest) {
    return this.org.listSimple(req.authCtx!.tenantId, 'job', this.listOpts(q));
  }

  @Get('units')
  @RequirePermission('org.view')
  listUnits(@Query() q: Record<string, string | undefined>, @Req() req: AuthenticatedRequest) {
    return this.org.listUnits(req.authCtx!.tenantId, {
      ...this.listOpts(q), type: q['type'], date: q['date'] && DATE_RE.test(q['date']) ? q['date'] : undefined,
    });
  }

  @Get('units/:id')
  @RequirePermission('org.view')
  async getUnit(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const unit = await this.org.getUnit(req.authCtx!.tenantId, uuid(id, 'id'));
    if (!unit) throw new HttpException('unité introuvable', 404);
    return unit;
  }

  @Get('positions')
  @RequirePermission('org.view')
  listPositions(@Query() q: Record<string, string | undefined>, @Req() req: AuthenticatedRequest) {
    return this.org.listPositions(req.authCtx!.tenantId, {
      ...this.listOpts(q),
      unitId: q['unitId'] ? uuid(q['unitId'], 'unitId') : undefined,
      date: q['date'] && DATE_RE.test(q['date']) ? q['date'] : undefined,
    });
  }

  @Get('positions/:id')
  @RequirePermission('org.view')
  async getPosition(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const pos = await this.org.getPosition(req.authCtx!.tenantId, uuid(id, 'id'));
    if (!pos) throw new HttpException('poste introuvable', 404);
    return pos;
  }

  @Get('positions/:id/manager-line')
  @RequirePermission('org.view')
  async managerLine(
    @Param('id') id: string, @Query('date') date: string | undefined, @Req() req: AuthenticatedRequest,
  ) {
    const d = dateOrToday(date, 'date');
    const line = await this.org.managerLine(req.authCtx!.tenantId, uuid(id, 'id'), d);
    if (line === null) throw new HttpException('poste introuvable', 404);
    return { date: d, managers: line };
  }

  @Get('chart')
  @RequirePermission('org.view')
  chart(
    @Query('date') date: string | undefined, @Query('rootUnitId') root: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.org.chart(req.authCtx!.tenantId, dateOrToday(date, 'date'), root ? uuid(root, 'rootUnitId') : null);
  }

  @Get('changes/:id')
  @RequirePermission('org.view')
  async getChange(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const change = await this.org.getPendingChange(req.authCtx!.tenantId, uuid(id, 'id'));
    if (!change) throw new HttpException('changement introuvable', 404);
    return change;
  }

  // ---------------- réorganisation (org.manage + portée réelle) ----------------

  // PAS de @RequirePermission ici : la garde v1 n'évalue que le niveau tenant ; le
  // service évalue org.manage PAR CIBLE (portée couvrant l'unité) — première portée fine.
  @Post('units/:id/move')
  @HttpCode(200)
  async moveUnit(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const newParent = b['newParentUnitId'] === null ? null : optUuid(b['newParentUnitId'], 'newParentUnitId') ?? null;
    const outcome: MoveOutcome = await this.org.moveUnit(a.tenantId, a.userId, uuid(id, 'id'), {
      newParentUnitId: newParent,
      effectiveFrom: str(b, 'effectiveFrom', 10),
      workflowDefinitionKey: optStr(b, 'workflowDefinitionKey', 100),
    });
    switch (outcome.kind) {
      case 'ok': return { moved: true, effectiveFrom: outcome.effectiveFrom, parentUnitId: outcome.parentUnitId };
      case 'submitted': return { submitted: true, pendingChangeId: outcome.pendingChangeId, workflowInstanceId: outcome.workflowInstanceId };
      case 'not_found': throw new HttpException('unité introuvable', 404);
      case 'forbidden': throw new ForbiddenException(outcome.reason);
      case 'cycle': throw new HttpException({ statusCode: 409, message: 'cycle organisationnel refusé', code: 'cycle' }, 409);
      case 'invalid': throw new BadRequestException(outcome.reason);
      case 'no_active_definition': throw new HttpException('aucune définition de workflow active pour cette clé', 404);
    }
  }

  // ---------------- import (org.import) ----------------

  @Post('import')
  @HttpCode(200)
  @RequirePermission('org.import')
  async import(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const mode = str(b, 'mode', 10);
    if (mode !== 'preview' && mode !== 'apply') throw new BadRequestException('mode : preview ou apply');
    const csv = b['csv'];
    if (typeof csv !== 'string' || csv.length === 0) throw new BadRequestException('csv requis');
    const outcome = await this.orgImport.run(a.tenantId, a.userId, {
      csv, mode, defaultEffectiveFrom: optStr(b, 'defaultEffectiveFrom', 10),
    });
    switch (outcome.kind) {
      case 'invalid':
        // 422 : rapport d'erreurs détaillé, AUCUNE écriture effectuée.
        throw new HttpException({ statusCode: 422, message: 'import refusé — aucune écriture', errors: outcome.errors, counts: outcome.counts }, 422);
      case 'preview_ok': return { mode: 'preview', valid: true, counts: outcome.counts };
      case 'applied': return { mode: 'apply', applied: true, counts: outcome.counts };
    }
  }

  // ---------------- privé ----------------

  private listOpts(q: Record<string, string | undefined>) {
    return {
      query: q['query'] && q['query'].length <= 100 ? q['query'] : undefined,
      status: q['status'] && ['draft', 'active', 'inactive', 'archived'].includes(q['status']) ? q['status'] : undefined,
      limit: q['limit'] ? Number(q['limit']) : undefined,
      offset: q['offset'] ? Number(q['offset']) : undefined,
    };
  }
}
