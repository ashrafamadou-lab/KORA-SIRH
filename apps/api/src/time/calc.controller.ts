/**
 * E10.2 — Routes du moteur de présence : exécutions (calcul, recalcul motivé,
 * prévisualisation), résultats (self, registre, calendrier, détail, historique,
 * comparaison), anomalies (file, changement d'état contrôlé), agrégats.
 * Le déclenchement est une opération de niveau tenant (garde déclarative) ;
 * TOUTES les consultations passent par les portées réelles du service.
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
import { ANOMALY_CATALOG } from '../../../../packages/core/src/presence.ts';
import { CalcService, type RunInput } from './calc.service';
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

function runInput(b: Record<string, unknown>): RunInput {
  const scopeKind = str(b, 'scopeKind', 10);
  if (!['tenant', 'company', 'site', 'unit', 'employee'].includes(scopeKind)) {
    throw new BadRequestException('scopeKind : tenant, company, site, unit ou employee');
  }
  return {
    periodStart: str(b, 'periodStart', 10),
    periodEnd: str(b, 'periodEnd', 10),
    scopeKind: scopeKind as RunInput['scopeKind'],
    scopeId: optUuid(b['scopeId'], 'scopeId'),
    reason: str(b, 'reason', 300),
  };
}

@Controller('time')
@UseGuards(SessionGuard, PermissionsGuard)
export class CalcController {
  constructor(private readonly calc: CalcService) {}

  // ---------------- Exécutions ----------------

  @Post('calc/run')
  @HttpCode(201)
  @RequirePermission('time.calc_run')
  async run(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.calc.run(a.tenantId, a.userId, runInput(b), { recalc: false }));
  }

  /** Recalcul MOTIVÉ : nouvelle version en cas d'écart, historique conservé. */
  @Post('calc/recalc')
  @HttpCode(201)
  @RequirePermission('time.calc_recalc')
  async recalc(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.calc.run(a.tenantId, a.userId, runInput(b), { recalc: true }));
  }

  /** Prévisualisation d'un recalcul : compare, N'ÉCRIT RIEN. */
  @Post('calc/preview')
  @HttpCode(200)
  @RequirePermission('time.calc_recalc')
  async preview(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.calc.preview(a.tenantId, a.userId, runInput(b)));
  }

  @Get('calc/runs')
  async listRuns(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.calc.listRuns(a.tenantId, a.userId, {
      limit: num(q['limit'], 'limit'), offset: num(q['offset'], 'offset'),
    }));
  }

  @Get('calc/runs/:id')
  async getRun(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.calc.getRun(a.tenantId, a.userId, uuid(id, 'id')));
  }

  // ---------------- Résultats ----------------

  @Get('results/mine')
  async mine(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.calc.myResults(a.tenantId, a.userId, {
      from: single(q['from'], 'from'), to: single(q['to'], 'to'),
    }));
  }

  /** Registre QUOTIDIEN (une date, portée réelle). */
  @Get('results')
  async register(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const date = single(q['date'], 'date');
    if (!date) throw new BadRequestException('paramètre « date » requis (AAAA-MM-JJ)');
    return unwrap(await this.calc.listResults(a.tenantId, a.userId, {
      date,
      status: single(q['status'], 'status'),
      siteId: optUuid(single(q['siteId'], 'siteId'), 'siteId'),
      unitId: optUuid(single(q['unitId'], 'unitId'), 'unitId'),
      limit: num(q['limit'], 'limit'), offset: num(q['offset'], 'offset'),
    }));
  }

  /** Calendrier d'un salarié (self via results_view_own, sinon portée + audit). */
  @Get('results/employee/:id')
  async calendar(
    @Param('id') id: string, @Query() q: Record<string, string | string[] | undefined>,
    @Req() req: AuthenticatedRequest,
  ) {
    const a = req.authCtx!;
    const from = single(q['from'], 'from');
    const to = single(q['to'], 'to');
    if (!from || !to) throw new BadRequestException('paramètres « from » et « to » requis');
    return unwrap(await this.calc.employeeResults(a.tenantId, a.userId, uuid(id, 'id'), { from, to }));
  }

  /** Détail d'une JOURNÉE : résultat, anomalies, chronologie des pointages, versions. */
  @Get('results/day')
  async day(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const employeeId = single(q['employeeId'], 'employeeId');
    const date = single(q['date'], 'date');
    if (!employeeId || !date) throw new BadRequestException('paramètres « employeeId » et « date » requis');
    return unwrap(await this.calc.dayDetail(a.tenantId, a.userId, uuid(employeeId, 'employeeId'), date));
  }

  /** HISTORIQUE des versions d'une journée (chaque recalcul reste explicable). */
  @Get('results/history')
  async history(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const employeeId = single(q['employeeId'], 'employeeId');
    const date = single(q['date'], 'date');
    if (!employeeId || !date) throw new BadRequestException('paramètres « employeeId » et « date » requis');
    return unwrap(await this.calc.history(a.tenantId, a.userId, uuid(employeeId, 'employeeId'), date));
  }

  /** COMPARAISON de deux versions d'une journée. */
  @Get('results/compare')
  async compare(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const employeeId = single(q['employeeId'], 'employeeId');
    const date = single(q['date'], 'date');
    const v1 = num(q['v1'], 'v1');
    const v2 = num(q['v2'], 'v2');
    if (!employeeId || !date || v1 === undefined || v2 === undefined) {
      throw new BadRequestException('paramètres « employeeId », « date », « v1 », « v2 » requis');
    }
    return unwrap(await this.calc.compare(a.tenantId, a.userId, uuid(employeeId, 'employeeId'), date, v1, v2));
  }

  /** Agrégats RETRAÇABLES (mêmes lignes que les écrans — PAS un module de paie). */
  @Get('results/aggregates')
  async aggregates(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const from = single(q['from'], 'from');
    const to = single(q['to'], 'to');
    if (!from || !to) throw new BadRequestException('paramètres « from » et « to » requis');
    return unwrap(await this.calc.aggregates(a.tenantId, a.userId, {
      from, to,
      siteId: optUuid(single(q['siteId'], 'siteId'), 'siteId'),
      unitId: optUuid(single(q['unitId'], 'unitId'), 'unitId'),
      employeeId: optUuid(single(q['employeeId'], 'employeeId'), 'employeeId'),
    }));
  }

  // ---------------- Anomalies ----------------

  /** Catalogue FERMÉ des anomalies (codes stables, libellés FR/EN, sévérité). */
  @Get('anomalies/catalog')
  catalog() {
    return {
      items: Object.entries(ANOMALY_CATALOG).map(([code, c]) => ({
        code, labelFr: c.fr, labelEn: c.en, defaultSeverity: c.defaultSeverity,
      })),
    };
  }

  @Get('anomalies')
  async anomalies(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.calc.listAnomalies(a.tenantId, a.userId, {
      state: single(q['state'], 'state'),
      severity: single(q['severity'], 'severity'),
      code: single(q['code'], 'code'),
      from: single(q['from'], 'from'), to: single(q['to'], 'to'),
      limit: num(q['limit'], 'limit'), offset: num(q['offset'], 'offset'),
    }));
  }

  /** Prise en charge / écartement / classement motivé — la résolution par CORRECTION
   * est automatique (application approuvée) ; le classement exige resolutionKind +
   * note (référence probante, trigger). PAS de garde déclarative : elle exigerait la
   * portée TENANT (v1) et exclurait les responsables à portée fine — le SERVICE exige
   * time.anomalies_manage ET borne l'action (CI run 30757393308 : 403 au lieu de 404). */
  @Post('anomalies/:id/state')
  @HttpCode(200)
  async setState(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const note = b?.['note'];
    if (note !== undefined && note !== null && typeof note !== 'string') throw new BadRequestException('note : texte');
    const rk = b?.['resolutionKind'];
    if (rk !== undefined && rk !== null && rk !== 'classified') throw new BadRequestException('resolutionKind : « classified » (la résolution par correction est automatique)');
    return unwrap(await this.calc.setAnomalyState(a.tenantId, a.userId, uuid(id, 'id'), {
      state: str(b, 'state', 20),
      note: typeof note === 'string' && note.length > 0 ? note : undefined,
      resolutionKind: rk === 'classified' ? 'classified' : undefined,
    }));
  }

  /** Affectation à un gestionnaire + échéance de traitement — auditée. */
  @Post('anomalies/:id/assign')
  @HttpCode(200)
  async assign(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const due = b?.['dueAt'];
    if (due !== undefined && due !== null && typeof due !== 'string') throw new BadRequestException('dueAt : horodatage ISO');
    return unwrap(await this.calc.assignAnomaly(a.tenantId, a.userId, uuid(id, 'id'), {
      userId: b?.['userId'] === null ? null : optUuid(b?.['userId'], 'userId') ?? null,
      dueAt: typeof due === 'string' ? due : null,
    }));
  }
}
