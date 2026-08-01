import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpException,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { AuditService, type AuditFilters } from './audit.service';
import { parseAuditCursor } from '../../../../packages/core/src/audit-view.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[1-9][0-9]{0,17}$/;
const NAME_RE = /^[a-z0-9_.:-]{1,100}$/i;

function optUuid(v: string | undefined, field: string): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (!UUID_RE.test(v)) throw new BadRequestException(`« ${field} » n'est pas un UUID`);
  return v;
}

function optName(v: string | undefined, field: string): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (!NAME_RE.test(v)) throw new BadRequestException(`« ${field} » est invalide`);
  return v;
}

function optDate(v: string | undefined, field: string): Date | undefined {
  if (v === undefined || v === '') return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`« ${field} » n'est pas une date valide`);
  return d;
}

function clampInt(v: string | undefined, def: number, min: number, max: number, field: string): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new BadRequestException(`« ${field} » doit être un entier`);
  return Math.min(Math.max(n, min), max);
}

/**
 * Consultation du journal d'audit — E6. STRICTEMENT EN LECTURE : ce contrôleur n'expose
 * que des GET ; aucune route POST/PUT/PATCH/DELETE n'existe sur /audit, et la base
 * refuse de toute façon UPDATE/DELETE (trigger + absence de grant). Les périmètres de
 * vue sont résolus par permission dans le service ; l'export et la vérification
 * d'intégrité exigent en plus leur permission dédiée.
 */
@Controller('audit')
@UseGuards(SessionGuard, PermissionsGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** Chaque paramètre de requête doit être UNIQUE : un doublon (?module=a&module=b)
   *  arrive en tableau et est REFUSÉ — jamais ignoré en silence (un filtre ignoré
   *  élargirait la réponse au lieu de l'étrécir). */
  private single(q: Record<string, unknown>): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined) continue;
      if (typeof v !== 'string') throw new BadRequestException(`paramètre « ${k} » répété ou invalide`);
      out[k] = v;
    }
    return out;
  }

  private filters(q: Record<string, string | undefined>): AuditFilters {
    const result = optName(q['result'], 'result');
    if (result && !['success', 'denied', 'failure'].includes(result)) {
      throw new BadRequestException('« result » : success, denied ou failure');
    }
    return {
      from: optDate(q['from'], 'from'),
      to: optDate(q['to'], 'to'),
      actorUserId: optUuid(q['actorUserId'], 'actorUserId'),
      action: optName(q['action'], 'action'),
      module: optName(q['module'], 'module'),
      recordType: optName(q['recordType'], 'recordType'),
      recordId: q['recordId'] && q['recordId'].length <= 200 ? q['recordId'] : undefined,
      result,
      correlationId: optUuid(q['correlationId'], 'correlationId'),
      employeeId: optUuid(q['employeeId'], 'employeeId'),
    };
  }

  @Get('events')
  async list(@Query() qraw: Record<string, unknown>, @Req() req: AuthenticatedRequest): Promise<unknown> {
    const a = req.authCtx!;
    const q = this.single(qraw);
    const cursor = parseAuditCursor(q['cursor']);
    if (!cursor.ok) throw new BadRequestException('curseur invalide');
    const limit = clampInt(q['limit'], 50, 1, 200, 'limit');
    const outcome = await this.audit.listEvents(a.tenantId, a.userId, this.filters(q), {
      beforeId: cursor.id === null ? null : String(cursor.id),
      limit,
    });
    if (outcome.kind === 'forbidden') throw new ForbiddenException('permission de consultation d’audit requise');
    return { items: outcome.items, nextCursor: outcome.nextCursor };
  }

  @Get('events/:id')
  async detail(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<unknown> {
    const a = req.authCtx!;
    if (!ID_RE.test(id)) throw new BadRequestException('identifiant invalide');
    const outcome = await this.audit.getEvent(a.tenantId, a.userId, id);
    if (outcome.kind === 'forbidden') throw new ForbiddenException('permission de consultation d’audit requise');
    if (outcome.kind === 'not_found') throw new HttpException('événement introuvable', 404);
    return outcome.event;
  }

  @Get('integrity')
  @RequirePermission('audit.view')
  async integrity(@Query() qraw: Record<string, unknown>, @Req() req: AuthenticatedRequest): Promise<unknown> {
    const a = req.authCtx!;
    const q = this.single(qraw);
    const maxRows = clampInt(q['maxRows'], 10_000, 100, 50_000, 'maxRows');
    const afterId = q['afterId'] !== undefined && q['afterId'] !== '' ? q['afterId'] : null;
    if (afterId !== null && !ID_RE.test(afterId)) throw new BadRequestException('« afterId » invalide');
    const seed = q['seed'] !== undefined && q['seed'] !== '' ? q['seed'] : null;
    if (seed !== null && !/^[0-9a-f]{64}$/.test(seed)) throw new BadRequestException('« seed » invalide (sha256 hex)');
    if ((afterId === null) !== (seed === null)) {
      throw new BadRequestException('« afterId » et « seed » vont ensemble (reprise d’une vérification)');
    }
    return this.audit.checkIntegrity(a.tenantId, a.userId, { maxRows, afterId, seed });
  }

  @Get('export/csv')
  @RequirePermission('audit.export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="kora-audit.csv"')
  async exportCsv(@Query() qraw: Record<string, unknown>, @Req() req: AuthenticatedRequest): Promise<string> {
    const a = req.authCtx!;
    const q = this.single(qraw);
    const limit = clampInt(q['limit'], 1000, 1, 10_000, 'limit');
    const outcome = await this.audit.exportEvents(a.tenantId, a.userId, this.filters(q), 'csv', limit);
    if (outcome.kind === 'forbidden') throw new ForbiddenException('permission de consultation d’audit requise');
    return outcome.csv!;
  }

  @Get('export/json')
  @RequirePermission('audit.export')
  async exportJson(@Query() qraw: Record<string, unknown>, @Req() req: AuthenticatedRequest): Promise<unknown> {
    const a = req.authCtx!;
    const q = this.single(qraw);
    const limit = clampInt(q['limit'], 1000, 1, 10_000, 'limit');
    const outcome = await this.audit.exportEvents(a.tenantId, a.userId, this.filters(q), 'json', limit);
    if (outcome.kind === 'forbidden') throw new ForbiddenException('permission de consultation d’audit requise');
    return { count: outcome.count, items: outcome.items };
  }
}
