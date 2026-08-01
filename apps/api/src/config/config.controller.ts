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
import { ConfigService } from './config.service';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function uuid(v: string, field: string): string {
  if (!UUID_RE.test(v)) throw new BadRequestException(`« ${field} » n'est pas un UUID`);
  return v;
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Config Center (E4). Lectures gardées par parameters.view ; les écritures vérifient la
 * permission fine (ordinaire vs juridique) DANS le service selon la sensibilité du
 * paramètre. Toutes les décisions sensibles sont auditées (module config).
 */
@Controller('config/parameters')
@UseGuards(SessionGuard, PermissionsGuard)
export class ConfigController {
  constructor(private readonly config: ConfigService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission('parameters.view') // garde grossière ; la permission fine est vérifiée en service
  async create(@Body() body: Record<string, unknown>, @Req() req: AuthenticatedRequest): Promise<{ id: string }> {
    const a = req.authCtx!;
    const outcome = await this.config.createDraft(a.tenantId, a.userId, {
      key: String(body?.['key'] ?? ''),
      value: body?.['value'],
      unit: (body?.['unit'] as string) ?? null,
      countryCode: (body?.['countryCode'] as string) ?? 'BJ',
      effectiveFrom: String(body?.['effectiveFrom'] ?? ''),
      sourceText: (body?.['sourceText'] as string) ?? null,
      sourceUrl: (body?.['sourceUrl'] as string) ?? null,
      legalRef: (body?.['legalRef'] as string) ?? null,
      notes: (body?.['notes'] as string) ?? null,
      isLegalSensitive: body?.['isLegalSensitive'] !== false,
    });
    if (outcome.kind === 'invalid') throw new BadRequestException(outcome.reason);
    if (outcome.kind === 'forbidden') throw new ForbiddenException(outcome.reason);
    return { id: outcome.id };
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermission('parameters.view')
  async submit(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ instanceId: string }> {
    const a = req.authCtx!;
    const definitionKey = String(body?.['definitionKey'] ?? '');
    if (!definitionKey) throw new BadRequestException('definitionKey requis (workflow de contreseing)');
    const outcome = await this.config.submit(a.tenantId, a.userId, uuid(id, 'id'), definitionKey);
    switch (outcome.kind) {
      case 'ok': return { instanceId: outcome.instanceId };
      case 'not_found': throw new HttpException('paramètre introuvable', 404);
      case 'forbidden': throw new ForbiddenException(outcome.reason);
      case 'bad_state': throw new HttpException({ statusCode: 409, message: `état ${outcome.status} : seul un draft est soumissible` }, 409);
      case 'no_workflow': throw new HttpException({ statusCode: 409, message: 'aucun workflow de contreseing actif pour cette clé' }, 409);
    }
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermission('parameters.view')
  async activate(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<{ status: string }> {
    const a = req.authCtx!;
    const outcome = await this.config.activate(a.tenantId, a.userId, uuid(id, 'id'), todayIso());
    switch (outcome.kind) {
      case 'ok': return { status: outcome.status };
      case 'not_found': throw new HttpException('paramètre introuvable', 404);
      case 'forbidden': throw new ForbiddenException(outcome.reason);
      case 'not_approved': throw new HttpException({ statusCode: 409, message: `état ${outcome.status} : le contreseing doit être approuvé d’abord` }, 409);
      case 'no_countersign': throw new HttpException({ statusCode: 409, message: 'contreseing manquant ou non approuvé' }, 409);
      case 'conflict': throw new HttpException({ statusCode: 409, message: outcome.reason, code: 'overlap' }, 409);
    }
  }

  @Post(':id/reset-draft')
  @HttpCode(200)
  @RequirePermission('parameters.view')
  async resetDraft(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<{ status: 'draft' }> {
    const a = req.authCtx!;
    const outcome = await this.config.resetToDraft(a.tenantId, a.userId, uuid(id, 'id'));
    if (outcome.kind === 'not_found') throw new HttpException('paramètre introuvable', 404);
    if (outcome.kind === 'bad_state') throw new HttpException({ statusCode: 409, message: `état ${outcome.status} : seul un paramètre rejeté peut repartir en draft` }, 409);
    return { status: 'draft' };
  }

  @Post('tick')
  @HttpCode(200)
  @RequirePermission('parameters.activate')
  async tick(@Req() req: AuthenticatedRequest): Promise<{ promoted: number }> {
    return this.config.promoteScheduled(req.authCtx!.tenantId, todayIso());
  }

  @Get('resolve')
  @RequirePermission('parameters.view')
  async resolve(
    @Query('key') key: string,
    @Query('date') date: string,
    @Query('country') country: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<unknown> {
    if (!key) throw new BadRequestException('key requis');
    if (!date || !DATE_RE.test(date)) throw new BadRequestException('date (YYYY-MM-DD) requise');
    const value = await this.config.resolveAt(req.authCtx!.tenantId, key, country ?? 'BJ', date);
    if (value === null) throw new HttpException('aucune valeur applicable à cette date', 404);
    return value;
  }

  @Get('history')
  @RequirePermission('parameters.view')
  history(
    @Query('key') key: string,
    @Query('country') country: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<unknown[]> {
    if (!key) throw new BadRequestException('key requis');
    return this.config.history(req.authCtx!.tenantId, key, country ?? 'BJ');
  }

  @Get(':id/preview')
  @RequirePermission('parameters.view')
  async preview(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<unknown> {
    const value = await this.config.preview(req.authCtx!.tenantId, uuid(id, 'id'));
    if (value === null) throw new HttpException('paramètre introuvable', 404);
    return value;
  }
}
