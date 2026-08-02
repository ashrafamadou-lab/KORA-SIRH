/**
 * E10.1 — Horaires : routes. Administration (manage/assign) = garde déclarative
 * (portée tenant) ; consultations = contrôle service (toute portée détient la
 * permission ; les données de POINTAGE, elles, sont filtrées par portée réelle).
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
import { SchedulesService, type ScheduleDayInput } from './schedules.service';
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
function single(v: string | string[] | undefined, field: string): string | undefined {
  if (Array.isArray(v)) throw new BadRequestException(`paramètre « ${field} » répété`);
  return v;
}
function intOr(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new BadRequestException(`« ${field} » : entier requis`);
  return v;
}
function optInt(v: unknown, field: string): number | null {
  if (v === undefined || v === null) return null;
  return intOr(v, field);
}

/** Traduction UNIFORME des issues de service en HTTP. */
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
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  // ---------------- Modèles et versions ----------------

  @Get('schedules/models')
  async listModels(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.schedules.listModels(a.tenantId, a.userId));
  }

  @Get('schedules/models/:id')
  async getModel(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.schedules.getModel(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Post('schedules/models')
  @HttpCode(201)
  @RequirePermission('time.schedules_manage')
  async createModel(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const kind = str(b, 'kind', 10);
    if (kind !== 'fixed' && kind !== 'rotation') throw new BadRequestException('kind : fixed ou rotation');
    return unwrap(await this.schedules.createModel(a.tenantId, a.userId, {
      code: str(b, 'code', 30), labelFr: str(b, 'labelFr'), labelEn: str(b, 'labelEn'), kind,
    }));
  }

  @Post('schedules/models/:id/retire')
  @HttpCode(200)
  @RequirePermission('time.schedules_manage')
  async retireModel(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.schedules.retireModel(a.tenantId, a.userId, uuid(id, 'id')));
  }

  @Post('schedules/models/:id/versions')
  @HttpCode(201)
  @RequirePermission('time.schedules_manage')
  async addVersion(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const daysRaw = b?.['days'];
    if (!Array.isArray(daysRaw) || daysRaw.length === 0 || daysRaw.length > 42) {
      throw new BadRequestException('days : tableau de 1 à 42 jours requis');
    }
    const days: ScheduleDayInput[] = daysRaw.map((d) => {
      const o = d as Record<string, unknown>;
      return {
        dayIndex: intOr(o['dayIndex'], 'dayIndex'),
        isRest: o['isRest'] === true,
        startMinute: optInt(o['startMinute'], 'startMinute'),
        endMinute: optInt(o['endMinute'], 'endMinute'),
        breakStartMinute: optInt(o['breakStartMinute'], 'breakStartMinute'),
        breakEndMinute: optInt(o['breakEndMinute'], 'breakEndMinute'),
        label: optStr(o, 'label', 100) ?? null,
      };
    });
    return unwrap(await this.schedules.addVersion(a.tenantId, a.userId, uuid(id, 'id'), {
      effectiveFrom: str(b, 'effectiveFrom', 10),
      cycleDays: intOr(b['cycleDays'], 'cycleDays'),
      days,
      notes: optStr(b, 'notes', 500) ?? null,
    }));
  }

  // ---------------- Affectations ----------------

  @Get('schedules/assignments')
  async listAssignments(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.schedules.listAssignments(a.tenantId, a.userId, {
      employeeId: optUuid(single(q['employeeId'], 'employeeId'), 'employeeId'),
      unitId: optUuid(single(q['unitId'], 'unitId'), 'unitId'),
      at: single(q['at'], 'at'),
      limit: single(q['limit'], 'limit') ? Number(single(q['limit'], 'limit')) : undefined,
      offset: single(q['offset'], 'offset') ? Number(single(q['offset'], 'offset')) : undefined,
    }));
  }

  @Post('schedules/assignments')
  @HttpCode(201)
  @RequirePermission('time.schedules_assign')
  async assign(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.schedules.assign(a.tenantId, a.userId, {
      employeeId: uuid(b['employeeId'], 'employeeId'),
      modelId: uuid(b['modelId'], 'modelId'),
      anchorDate: str(b, 'anchorDate', 10),
      effectiveFrom: str(b, 'effectiveFrom', 10),
      closePrevious: b['closePrevious'] === true,
    }));
  }

  @Post('schedules/assignments/by-unit')
  @HttpCode(200)
  @RequirePermission('time.schedules_assign')
  async assignByUnit(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.schedules.assignByUnit(a.tenantId, a.userId, {
      unitId: uuid(b['unitId'], 'unitId'),
      modelId: uuid(b['modelId'], 'modelId'),
      anchorDate: str(b, 'anchorDate', 10),
      effectiveFrom: str(b, 'effectiveFrom', 10),
      closePrevious: b['closePrevious'] === true,
    }));
  }

  @Post('schedules/assignments/:id/close')
  @HttpCode(200)
  @RequirePermission('time.schedules_assign')
  async closeAssignment(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.schedules.closeAssignment(a.tenantId, a.userId, uuid(id, 'id'), str(b, 'effectiveTo', 10)));
  }

  /** Horaire APPLICABLE à une date — rotation, version datée, exception, férié. */
  @Get('employees/:id/schedule')
  async employeeSchedule(
    @Param('id') id: string,
    @Query() q: Record<string, string | string[] | undefined>,
    @Req() req: AuthenticatedRequest,
  ) {
    const a = req.authCtx!;
    const date = single(q['date'], 'date') ?? new Date().toISOString().slice(0, 10);
    // Réponse À PLAT (l'horaire EST la ressource) — contrat consommé tel quel par la PWA.
    const out = unwrap(await this.schedules.employeeScheduleAt(a.tenantId, a.userId, uuid(id, 'id'), date));
    return out.schedule;
  }

  // ---------------- Fériés ----------------

  @Get('holidays')
  async listHolidays(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const year = single(q['year'], 'year');
    return unwrap(await this.schedules.listHolidays(a.tenantId, a.userId, {
      calendarId: optUuid(single(q['calendarId'], 'calendarId'), 'calendarId'),
      year: year ? Number(year) : undefined,
    }));
  }

  @Post('holidays/calendars')
  @HttpCode(201)
  @RequirePermission('time.schedules_manage')
  async createCalendar(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.schedules.createCalendar(a.tenantId, a.userId, {
      code: str(b, 'code', 30), labelFr: str(b, 'labelFr'), labelEn: str(b, 'labelEn'),
      companyId: optUuid(b['companyId'], 'companyId'),
      siteId: optUuid(b['siteId'], 'siteId'),
      unitId: optUuid(b['unitId'], 'unitId'),
    }));
  }

  @Post('holidays')
  @HttpCode(201)
  @RequirePermission('time.schedules_manage')
  async addHoliday(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.schedules.addHoliday(a.tenantId, a.userId, {
      calendarId: uuid(b['calendarId'], 'calendarId'),
      date: str(b, 'date', 10), labelFr: str(b, 'labelFr'), labelEn: str(b, 'labelEn'),
    }));
  }

  @Post('holidays/:id/retire')
  @HttpCode(200)
  @RequirePermission('time.schedules_manage')
  async retireHoliday(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.schedules.retireHoliday(a.tenantId, a.userId, uuid(id, 'id')));
  }

  // ---------------- Exceptions ----------------

  @Get('exceptions')
  async listExceptions(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.schedules.listExceptions(a.tenantId, a.userId, {
      from: single(q['from'], 'from'), to: single(q['to'], 'to'),
    }));
  }

  @Post('exceptions')
  @HttpCode(201)
  @RequirePermission('time.schedules_manage')
  async createException(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const kind = str(b, 'kind', 20);
    if (!['closed', 'rest', 'special_hours'].includes(kind)) {
      throw new BadRequestException('kind : closed, rest ou special_hours');
    }
    return unwrap(await this.schedules.createException(a.tenantId, a.userId, {
      date: str(b, 'date', 10),
      kind: kind as 'closed' | 'rest' | 'special_hours',
      labelFr: str(b, 'labelFr'), labelEn: str(b, 'labelEn'),
      employeeId: optUuid(b['employeeId'], 'employeeId'),
      unitId: optUuid(b['unitId'], 'unitId'),
      siteId: optUuid(b['siteId'], 'siteId'),
      companyId: optUuid(b['companyId'], 'companyId'),
      startMinute: optInt(b['startMinute'], 'startMinute'),
      endMinute: optInt(b['endMinute'], 'endMinute'),
    }));
  }

  @Post('exceptions/:id/retire')
  @HttpCode(200)
  @RequirePermission('time.schedules_manage')
  async retireException(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.schedules.retireException(a.tenantId, a.userId, uuid(id, 'id')));
  }
}
