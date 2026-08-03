/**
 * E11.1 — Routes congés : référentiel (types, politiques versionnées, résolution,
 * population), acquisitions (exécutions idempotentes, report/expiration), soldes
 * (portées self/équipe/RH réelles), ledger masqué, projection, décompte,
 * ajustements motivés (E3 si sensible), import de soldes d'ouverture.
 * Les gardes déclaratives couvrent l'ADMINISTRATION ; toute consultation passe
 * par les portées réelles du service (l'identifiant transmis n'élargit rien).
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
import { LeaveCatalogService, type PolicyVersionInput, type TypeInput } from './catalog.service';
import { LeaveAccrualService, type AccrualRunInput } from './accrual.service';
import { LeaveBalancesService } from './balances.service';
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
    case 'not_found': throw new HttpException('ressource introuvable', 404);
    case 'invalid': throw new BadRequestException(out.reason);
    case 'conflict': throw new ConflictException(out.reason);
    default: throw new BadRequestException('requête invalide');
  }
}

@Controller('leave')
@UseGuards(SessionGuard, PermissionsGuard)
export class LeaveController {
  constructor(
    private readonly catalog: LeaveCatalogService,
    private readonly accrual: LeaveAccrualService,
    private readonly balances: LeaveBalancesService,
  ) {}

  // ---------------- Référentiel : types ----------------

  @Get('types')
  async listTypes(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.listTypes(a.tenantId, a.userId));
  }

  @Post('types')
  @HttpCode(201)
  @RequirePermission('leave.types_admin')
  async createType(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.createType(a.tenantId, a.userId, b as unknown as TypeInput));
  }

  @Post('types/:id')
  @HttpCode(200)
  @RequirePermission('leave.types_admin')
  async updateType(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.updateType(a.tenantId, a.userId, uuid(id, 'id'), b as never));
  }

  // ---------------- Référentiel : politiques ----------------

  @Get('policies')
  async listPolicies(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.listPolicies(a.tenantId, a.userId));
  }

  @Post('policies')
  @HttpCode(201)
  @RequirePermission('leave.policies_admin')
  async createPolicy(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.createPolicy(a.tenantId, a.userId, {
      absenceTypeId: uuid(b['absenceTypeId'], 'absenceTypeId'),
      code: str(b, 'code', 30), labelFr: str(b, 'labelFr', 120), labelEn: str(b, 'labelEn', 120),
      countryCode: (b['countryCode'] as string | undefined) ?? null,
      companyId: optUuid(b['companyId'], 'companyId') ?? null,
      siteId: optUuid(b['siteId'], 'siteId') ?? null,
      collectiveAgreement: (b['collectiveAgreement'] as string | undefined) ?? null,
      professionalCategory: (b['professionalCategory'] as string | undefined) ?? null,
      contractType: (b['contractType'] as string | undefined) ?? null,
      employeeStatus: (b['employeeStatus'] as string | undefined) ?? null,
      seniorityMinMonths: (b['seniorityMinMonths'] as number | undefined) ?? null,
      workTime: (b['workTime'] as string | undefined) ?? 'any',
      populationKey: (b['populationKey'] as string | undefined) ?? null,
    }));
  }

  @Post('policies/:id/versions')
  @HttpCode(201)
  @RequirePermission('leave.policies_admin')
  async addVersion(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.addPolicyVersion(a.tenantId, a.userId, uuid(id, 'id'), b as unknown as PolicyVersionInput));
  }

  @Post('policies/:id/status')
  @HttpCode(200)
  @RequirePermission('leave.policies_admin')
  async policyStatus(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.setPolicyStatus(a.tenantId, a.userId, uuid(id, 'id'), str(b, 'status', 10)));
  }

  @Get('policies/resolve')
  async resolve(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const employeeId = uuid(single(q['employeeId'], 'employeeId'), 'employeeId');
    const typeId = uuid(single(q['typeId'], 'typeId'), 'typeId');
    const date = single(q['date'], 'date') ?? new Date().toISOString().slice(0, 10);
    return unwrap(await this.catalog.resolve(a.tenantId, a.userId, employeeId, typeId, date));
  }

  @Get('policies/:id/population')
  async population(@Param('id') id: string, @Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const date = single(q['date'], 'date') ?? new Date().toISOString().slice(0, 10);
    return unwrap(await this.catalog.population(a.tenantId, a.userId, uuid(id, 'id'), date));
  }

  // ---------------- Acquisitions ----------------

  @Post('accrual/run')
  @HttpCode(201)
  @RequirePermission('leave.accrual_run')
  async run(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const scopeKind = str(b, 'scopeKind', 10);
    if (!['tenant', 'company', 'site', 'employee'].includes(scopeKind)) {
      throw new BadRequestException('scopeKind : tenant, company, site ou employee');
    }
    const kind = (b['kind'] as string | undefined) ?? 'accrual';
    if (!['accrual', 'carry_over', 'recompute'].includes(kind)) {
      throw new BadRequestException('kind : accrual, carry_over ou recompute');
    }
    const input: AccrualRunInput = {
      periodStart: str(b, 'periodStart', 10), periodEnd: str(b, 'periodEnd', 10),
      scopeKind: scopeKind as AccrualRunInput['scopeKind'],
      scopeId: optUuid(b['scopeId'], 'scopeId'),
      reason: str(b, 'reason', 300),
      kind: kind as AccrualRunInput['kind'],
    };
    return unwrap(await this.accrual.run(a.tenantId, a.userId, input));
  }

  @Get('accrual/runs')
  async runs(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.accrual.listRuns(a.tenantId, a.userId));
  }

  // ---------------- Soldes, projection, ledger, décompte ----------------

  @Get('balances')
  async balancesList(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.balances.listBalances(a.tenantId, a.userId, {
      employeeId: optUuid(single(q['employeeId'], 'employeeId'), 'employeeId'),
      typeId: optUuid(single(q['typeId'], 'typeId'), 'typeId'),
      date: single(q['date'], 'date'),
    }));
  }

  @Get('balances/mine')
  async myBalances(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.balances.myBalances(a.tenantId, a.userId));
  }

  @Get('projection')
  async projection(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const toDate = single(q['toDate'], 'toDate');
    if (!toDate) throw new BadRequestException('paramètre « toDate » requis');
    return unwrap(await this.balances.projection(a.tenantId, a.userId, {
      employeeId: optUuid(single(q['employeeId'], 'employeeId'), 'employeeId'),
      typeId: uuid(single(q['typeId'], 'typeId'), 'typeId'),
      toDate,
    }));
  }

  @Get('ledger')
  async ledger(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.balances.ledger(a.tenantId, a.userId, {
      employeeId: optUuid(single(q['employeeId'], 'employeeId'), 'employeeId'),
      typeId: optUuid(single(q['typeId'], 'typeId'), 'typeId'),
      self: false,
    }));
  }

  @Get('ledger/mine')
  async myLedger(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.balances.ledger(a.tenantId, a.userId, {
      typeId: optUuid(single(q['typeId'], 'typeId'), 'typeId'),
      self: true,
    }));
  }

  @Get('count')
  async count(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const from = single(q['from'], 'from');
    const to = single(q['to'], 'to');
    if (!from || !to) throw new BadRequestException('paramètres « from » et « to » requis');
    return unwrap(await this.balances.count(a.tenantId, a.userId, {
      employeeId: optUuid(single(q['employeeId'], 'employeeId'), 'employeeId'),
      typeId: uuid(single(q['typeId'], 'typeId'), 'typeId'),
      from, to,
      halfStart: single(q['halfStart'], 'halfStart') === '1',
      halfEnd: single(q['halfEnd'], 'halfEnd') === '1',
    }));
  }

  // ---------------- Ajustements & reprise ----------------

  @Post('adjust')
  @HttpCode(200)
  @RequirePermission('leave.balance_adjust')
  async adjust(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const direction = str(b, 'direction', 10);
    const quantity = b['quantity'];
    if (typeof quantity !== 'number') throw new BadRequestException('quantity : nombre requis');
    return unwrap(await this.balances.adjust(a.tenantId, a.userId, {
      employeeId: uuid(b['employeeId'], 'employeeId'),
      typeId: uuid(b['typeId'], 'typeId'),
      direction: direction as 'credit' | 'debit',
      quantity,
      reason: str(b, 'reason', 500),
      businessRef: (b['businessRef'] as string | undefined),
      periodStart: str(b, 'periodStart', 10),
      periodEnd: str(b, 'periodEnd', 10),
      idempotencyKey: (b['idempotencyKey'] as string | undefined),
    }));
  }

  @Post('openings/import')
  @HttpCode(200)
  @RequirePermission('leave.openings_import')
  async importOpenings(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const mode = str(b, 'mode', 10);
    if (!['preview', 'apply'].includes(mode)) throw new BadRequestException('mode : preview ou apply');
    const out = await this.balances.importOpenings(a.tenantId, a.userId, {
      mode: mode as 'preview' | 'apply',
      asOfDate: str(b, 'asOfDate', 10),
      contentText: str(b, 'contentText', 2_000_000),
      filename: (b['filename'] as string | undefined),
      atomic: (b['atomic'] as boolean | undefined),
      sourceNote: (b['sourceNote'] as string | undefined),
    });
    const r = unwrap(out);
    return { kind: r['kind2'], counts: r['counts'], errors: r['errors'], importId: r['importId'] };
  }

  @Get('openings')
  async imports(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.balances.listImports(a.tenantId, a.userId));
  }
}
