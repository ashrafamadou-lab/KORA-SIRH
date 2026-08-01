/**
 * E10.1 — Pointages : routes. L'import, la saisie manuelle, la renormalisation et
 * les dispositifs sont des opérations de niveau tenant (garde déclarative) ; les
 * consultations de POINTAGES passent par les portées réelles du service.
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
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { PunchesService } from './punches.service';
import { PunchImportService, type ImportInput } from './punch-import.service';
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
export class PunchesController {
  constructor(
    private readonly punches: PunchesService,
    private readonly importer: PunchImportService,
  ) {}

  // ---------------- Dispositifs et correspondances ----------------

  @Get('devices')
  async listDevices(@Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.punches.listDevices(a.tenantId, a.userId));
  }

  @Post('devices')
  @HttpCode(201)
  @RequirePermission('time.devices_manage')
  async createDevice(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.punches.createDevice(a.tenantId, a.userId, {
      code: str(b, 'code', 30), label: str(b, 'label'), kind: str(b, 'kind', 10),
      siteId: optUuid(b['siteId'], 'siteId'), timeZone: optStr(b, 'timeZone', 50),
    }));
  }

  @Patch('devices/:id')
  @RequirePermission('time.devices_manage')
  async patchDevice(@Param('id') id: string, @Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.punches.patchDevice(a.tenantId, a.userId, uuid(id, 'id'), {
      label: optStr(b, 'label'),
      status: optStr(b, 'status', 10),
      siteId: 'siteId' in b ? (b['siteId'] === null ? null : uuid(b['siteId'], 'siteId')) : undefined,
      timeZone: 'timeZone' in b ? (b['timeZone'] === null ? null : str(b, 'timeZone', 50)) : undefined,
    }));
  }

  @Get('mappings')
  async listMappings(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.punches.listMappings(a.tenantId, a.userId, {
      externalId: single(q['externalId'], 'externalId'),
      employeeId: optUuid(single(q['employeeId'], 'employeeId'), 'employeeId'),
    }));
  }

  @Post('mappings')
  @HttpCode(201)
  @RequirePermission('time.devices_manage')
  async createMapping(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.punches.createMapping(a.tenantId, a.userId, {
      externalId: str(b, 'externalId', 100),
      employeeId: uuid(b['employeeId'], 'employeeId'),
      deviceId: optUuid(b['deviceId'], 'deviceId'),
    }));
  }

  @Post('mappings/:id/retire')
  @HttpCode(200)
  @RequirePermission('time.devices_manage')
  async retireMapping(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.punches.retireMapping(a.tenantId, a.userId, uuid(id, 'id')));
  }

  // ---------------- Import ----------------

  @Post('punches/import')
  @HttpCode(200)
  @RequirePermission('time.punches_import')
  async importPunches(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    const source = str(b, 'source', 5);
    if (source !== 'csv' && source !== 'xlsx') throw new BadRequestException('source : csv ou xlsx');
    const mode = str(b, 'mode', 8);
    if (mode !== 'preview' && mode !== 'apply') throw new BadRequestException('mode : preview ou apply');
    let mapping: ImportInput['mapping'];
    if (b['mapping'] !== undefined) {
      const m = b['mapping'];
      if (m === null || typeof m !== 'object' || Array.isArray(m)) throw new BadRequestException('mapping : objet colonne→rôle');
      for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
        if (typeof v !== 'string' || k.length > 100) throw new BadRequestException('mapping : valeurs texte requises');
      }
      mapping = m as ImportInput['mapping'];
    }
    const out = await this.importer.run(a.tenantId, a.userId, {
      source, mode,
      filename: optStr(b, 'filename', 300),
      contentText: typeof b['contentText'] === 'string' ? (b['contentText'] as string) : undefined,
      contentBase64: typeof b['contentBase64'] === 'string' ? (b['contentBase64'] as string) : undefined,
      mapping,
      defaultSiteId: optUuid(b['defaultSiteId'], 'defaultSiteId'),
      defaultDeviceId: optUuid(b['defaultDeviceId'], 'defaultDeviceId'),
      acceptOnlyValid: b['acceptOnlyValid'] === true,
      keepFile: b['keepFile'] !== false,
    });
    if (out.kind === 'invalid') throw new BadRequestException(out.reason);
    if (out.kind === 'not_found') throw new HttpException('ressource introuvable', 404);
    return out;
  }

  @Get('batches')
  async listBatches(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.importer.listBatches(a.tenantId, a.userId, {
      limit: single(q['limit'], 'limit') ? Number(single(q['limit'], 'limit')) : undefined,
      offset: single(q['offset'], 'offset') ? Number(single(q['offset'], 'offset')) : undefined,
    }));
  }

  @Get('batches/:id')
  async getBatch(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.importer.getBatch(a.tenantId, a.userId, uuid(id, 'id')));
  }

  /** Fichier original (référence documentaire) — permission d'IMPORT, accès audité. */
  @Get('batches/:id/file')
  @RequirePermission('time.punches_import')
  async batchFile(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.importer.batchFile(a.tenantId, a.userId, uuid(id, 'id')));
  }

  // ---------------- Consultations ----------------

  @Get('punches/raw')
  async listRaw(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.punches.listRawPunches(a.tenantId, a.userId, {
      batchId: optUuid(single(q['batchId'], 'batchId'), 'batchId'),
      deviceId: optUuid(single(q['deviceId'], 'deviceId'), 'deviceId'),
      from: single(q['from'], 'from'),
      to: single(q['to'], 'to'),
      limit: single(q['limit'], 'limit') ? Number(single(q['limit'], 'limit')) : undefined,
      offset: single(q['offset'], 'offset') ? Number(single(q['offset'], 'offset')) : undefined,
    }));
  }

  @Get('punches/mine')
  async myEvents(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.punches.listMyEvents(a.tenantId, a.userId, {
      from: single(q['from'], 'from'), to: single(q['to'], 'to'),
      limit: single(q['limit'], 'limit') ? Number(single(q['limit'], 'limit')) : undefined,
    }));
  }

  @Get('punches/unmatched')
  async unmatched(@Query() q: Record<string, string | string[] | undefined>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.punches.listUnmatched(a.tenantId, a.userId, {
      limit: single(q['limit'], 'limit') ? Number(single(q['limit'], 'limit')) : undefined,
      offset: single(q['offset'], 'offset') ? Number(single(q['offset'], 'offset')) : undefined,
    }));
  }

  @Post('punches/renormalize')
  @HttpCode(200)
  @RequirePermission('time.punches_import')
  async renormalize(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.punches.renormalize(a.tenantId, a.userId, {
      batchId: optUuid(b?.['batchId'], 'batchId'),
    }));
  }

  @Post('punches/manual')
  @HttpCode(201)
  @RequirePermission('time.punches_import')
  async manual(@Body() b: Record<string, unknown>, @Req() req: AuthenticatedRequest) {
    const a = req.authCtx!;
    return unwrap(await this.punches.manualPunch(a.tenantId, a.userId, {
      employeeId: uuid(b['employeeId'], 'employeeId'),
      dateTime: str(b, 'dateTime', 60),
      eventType: optStr(b, 'eventType', 30),
      siteId: optUuid(b['siteId'], 'siteId'),
      note: optStr(b, 'note', 300),
    }));
  }

}
