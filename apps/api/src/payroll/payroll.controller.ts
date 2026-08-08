/**
 * E12.1 — Routes de paie : référentiel (calendriers, périodes, structures,
 * rubriques versionnées, rémunération historisée, prélèvements paramétriques),
 * simulation SANS écriture, exécution versionnée, résultats expliqués ligne par
 * ligne, comparaison de deux calculs, cycle de période.
 */
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException,
  Get, HttpCode, HttpException, NotFoundException, Param, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { PayrollCatalogService, type RubricVersionInput } from './catalog.service';
import { PayrollCalcService } from './calc.service';
import type { TimeOutcome } from './payroll-access';

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
function bool(body: Record<string, unknown>, field: string): boolean {
  const v = body?.[field];
  if (typeof v !== 'boolean') throw new BadRequestException(`champ « ${field} » : booléen explicite requis`);
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

@Controller('payroll')
@UseGuards(SessionGuard, PermissionsGuard)
export class PayrollController {
  constructor(
    private readonly catalog: PayrollCatalogService,
    private readonly calc: PayrollCalcService,
  ) {}

  // ---------- Calendriers & périodes ----------

  @Post('calendars')
  @HttpCode(201)
  @RequirePermission('payroll.calendar_manage')
  async createCalendar(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.createCalendar(a.tenantId, a.userId, {
      code: str(b, 'code', 30), labelFr: str(b, 'labelFr', 120), labelEn: str(b, 'labelEn', 120),
      frequency: str(b, 'frequency', 10),
    }));
  }

  @Get('calendars')
  async listCalendars(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.listCalendars(a.tenantId, a.userId));
  }

  @Post('periods')
  @HttpCode(201)
  @RequirePermission('payroll.calendar_manage')
  async createPeriod(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.createPeriod(a.tenantId, a.userId, {
      calendarId: uuid(b['calendarId'], 'calendarId'), label: str(b, 'label', 100),
      periodStart: str(b, 'periodStart', 10), periodEnd: str(b, 'periodEnd', 10), payDate: str(b, 'payDate', 10),
    }));
  }

  @Get('periods')
  async listPeriods(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.listPeriods(a.tenantId, a.userId));
  }

  @Post('periods/:id/status')
  @HttpCode(200)
  @RequirePermission('payroll.run')
  async setStatus(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.calc.setStatus(a.tenantId, a.userId, uuid(id, 'id'), str(b, 'status', 12)));
  }

  @Post('periods/:id/reopen')
  @HttpCode(200)
  @RequirePermission('payroll.run')
  async reopen(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.calc.requestReopen(a.tenantId, a.userId, uuid(id, 'id'), str(b, 'reason', 500)));
  }

  // ---------- Structures ----------

  @Post('structures')
  @HttpCode(201)
  @RequirePermission('payroll.structures_manage')
  async createStructure(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.createStructure(a.tenantId, a.userId, {
      code: str(b, 'code', 30), labelFr: str(b, 'labelFr', 120), labelEn: str(b, 'labelEn', 120),
    }));
  }

  @Get('structures')
  async listStructures(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.listStructures(a.tenantId, a.userId));
  }

  @Post('structures/:id/status')
  @HttpCode(200)
  @RequirePermission('payroll.structures_manage')
  async structureStatus(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.setStructureStatus(a.tenantId, a.userId, uuid(id, 'id'), str(b, 'status', 10)));
  }

  @Post('structures/:id/rubrics')
  @HttpCode(200)
  @RequirePermission('payroll.structures_manage')
  async attachRubric(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const seq = b['sequence'];
    return unwrap(await this.catalog.attachRubric(a.tenantId, a.userId, uuid(id, 'id'),
      uuid(b['rubricId'], 'rubricId'), typeof seq === 'number' ? seq : 100));
  }

  // ---------- Rubriques ----------

  @Post('rubrics')
  @HttpCode(201)
  @RequirePermission('payroll.rubrics_manage')
  async createRubric(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const seq = b['sequence'];
    return unwrap(await this.catalog.createRubric(a.tenantId, a.userId, {
      code: str(b, 'code', 30), labelFr: str(b, 'labelFr', 120), labelEn: str(b, 'labelEn', 120),
      kind: str(b, 'kind', 20), taxable: bool(b, 'taxable'), cotisable: bool(b, 'cotisable'),
      sequence: typeof seq === 'number' ? seq : undefined,
      notes: typeof b['notes'] === 'string' ? b['notes'] : null,
    }));
  }

  @Get('rubrics')
  async listRubrics(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.listRubrics(a.tenantId, a.userId));
  }

  @Post('rubrics/:id/status')
  @HttpCode(200)
  @RequirePermission('payroll.rubrics_manage')
  async rubricStatus(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.setRubricStatus(a.tenantId, a.userId, uuid(id, 'id'), str(b, 'status', 10)));
  }

  @Post('rubrics/:id/versions')
  @HttpCode(201)
  @RequirePermission('payroll.rubrics_manage')
  async addRubricVersion(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.addRubricVersion(a.tenantId, a.userId, uuid(id, 'id'),
      b as unknown as RubricVersionInput));
  }

  // ---------- Rémunération ----------

  @Post('compensations')
  @HttpCode(201)
  @RequirePermission('payroll.compensation_manage')
  async addCompensation(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const amount = b['baseAmount'];
    if (typeof amount !== 'number') throw new BadRequestException('baseAmount : nombre requis');
    return unwrap(await this.catalog.addCompensation(a.tenantId, a.userId, {
      employeeId: uuid(b['employeeId'], 'employeeId'), structureId: uuid(b['structureId'], 'structureId'),
      effectiveFrom: str(b, 'effectiveFrom', 10), baseAmount: amount,
      currency: str(b, 'currency', 3), periodicity: str(b, 'periodicity', 10), reason: str(b, 'reason', 500),
    }));
  }

  @Get('compensations')
  async listCompensations(@Query() q: Record<string, string | string[]>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const emp = single(q['employeeId'], 'employeeId');
    return unwrap(await this.catalog.listCompensations(a.tenantId, a.userId,
      emp ? uuid(emp, 'employeeId') : undefined));
  }

  // ---------- Prélèvements (déclarés, non calculés en E12.1) ----------

  @Post('levies')
  @HttpCode(201)
  @RequirePermission('payroll.levies_manage')
  async createLevy(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.createLevy(a.tenantId, a.userId, {
      code: str(b, 'code', 30), labelFr: str(b, 'labelFr', 120), labelEn: str(b, 'labelEn', 120),
      kind: str(b, 'kind', 12), baseKind: str(b, 'baseKind', 12),
    }));
  }

  @Post('levies/:id/versions')
  @HttpCode(201)
  @RequirePermission('payroll.levies_manage')
  async addLevyVersion(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.addLevyVersion(a.tenantId, a.userId, uuid(id, 'id'), {
      effectiveFrom: str(b, 'effectiveFrom', 10), rateParamKey: str(b, 'rateParamKey', 120),
      ceilingParamKey: typeof b['ceilingParamKey'] === 'string' ? b['ceilingParamKey'] : null,
      floorParamKey: typeof b['floorParamKey'] === 'string' ? b['floorParamKey'] : null,
      exemption: b['exemption'] ?? null,
      notes: typeof b['notes'] === 'string' ? b['notes'] : null,
    }));
  }

  @Get('levies')
  async listLevies(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.catalog.listLevies(a.tenantId, a.userId));
  }

  // ---------- Simulation, exécution, résultats ----------

  @Post('simulate')
  @HttpCode(200)
  @RequirePermission('payroll.simulate')
  async simulate(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.calc.simulate(a.tenantId, a.userId, {
      periodId: uuid(b['periodId'], 'periodId'), employeeId: uuid(b['employeeId'], 'employeeId'),
    }));
  }

  @Post('runs')
  @HttpCode(201)
  @RequirePermission('payroll.run')
  async run(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const emp = b['employeeId'];
    return unwrap(await this.calc.run(a.tenantId, a.userId, {
      periodId: uuid(b['periodId'], 'periodId'),
      employeeId: typeof emp === 'string' && emp !== '' ? uuid(emp, 'employeeId') : undefined,
      reason: str(b, 'reason', 300),
    }));
  }

  @Get('periods/:id/runs')
  async listRuns(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.calc.listRuns(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Get('periods/:id/results')
  async results(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.calc.results(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Get('results/:id')
  async resultDetail(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.calc.resultDetail(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Get('results/:id/compare')
  async compare(@Param('id') id: string, @Query() q: Record<string, string | string[]>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const withId = single(q['with'], 'with');
    if (!withId) throw new BadRequestException('paramètre « with » requis (autre résultat du MÊME salarié)');
    return unwrap(await this.calc.compare(a.tenantId, a.userId, uuid(id, 'id'), uuid(withId, 'with')));
  }
}
