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
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminUsersService, type AdminUserRow } from './admin-users.service';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function requireUuid(v: string, field: string): string {
  if (!UUID_RE.test(v)) throw new BadRequestException(`« ${field} » n'est pas un UUID`);
  return v;
}

function breachToHttp(kind: 'breached' | 'breach_unavailable'): never {
  if (kind === 'breached') {
    throw new BadRequestException({ message: 'mot de passe présent dans une fuite connue', code: 'breached' });
  }
  throw new HttpException(
    { statusCode: 503, message: 'vérification de compromission indisponible', code: 'breach_unavailable' },
    503,
  );
}

/**
 * Administration des comptes (clôture E1/E2). TOUTES les routes sont protégées par le
 * RBAC réel (SessionGuard + PermissionsGuard chargeant la base) et tracées dans l'audit.
 * L'affectation de rôles est bornée aux permissions de l'acteur (anti-élévation).
 */
@Controller('admin/users')
@UseGuards(SessionGuard, PermissionsGuard)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @RequirePermission('users.view')
  list(@Req() req: AuthenticatedRequest): Promise<AdminUserRow[]> {
    return this.users.list(req.authCtx!.tenantId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('users.create')
  async create(
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ id: string }> {
    const email = String(body?.['email'] ?? '');
    const password = String(body?.['password'] ?? '');
    if (!EMAIL_RE.test(email) || email.length > 320) throw new BadRequestException('email invalide');
    if (password.length < 1 || password.length > 512) throw new BadRequestException('mot de passe invalide');
    const a = req.authCtx!;
    const outcome = await this.users.create(a.tenantId, a.userId, email, password);
    switch (outcome.kind) {
      case 'ok':
        return { id: outcome.id };
      case 'duplicate':
        throw new ConflictException('un compte existe déjà pour cet email');
      case 'policy':
        throw new BadRequestException({ message: 'mot de passe non conforme', issues: outcome.issues });
      case 'breached':
      case 'breach_unavailable':
        breachToHttp(outcome.kind);
    }
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermission('users.edit')
  async activate(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<{ active: true }> {
    const a = req.authCtx!;
    const res = await this.users.setActive(a.tenantId, a.userId, requireUuid(id, 'id'), true);
    if (res.kind === 'not_found') throw new HttpException('utilisateur introuvable', 404);
    return { active: true };
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermission('users.edit')
  async deactivate(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ active: false; sessionsRevoked: number }> {
    const a = req.authCtx!;
    const res = await this.users.setActive(a.tenantId, a.userId, requireUuid(id, 'id'), false);
    if (res.kind === 'not_found') throw new HttpException('utilisateur introuvable', 404);
    return { active: false, sessionsRevoked: res.sessionsRevoked };
  }

  @Post(':id/roles')
  @HttpCode(200)
  @RequirePermission('users.manage_roles')
  async assignRoles(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ assigned: true }> {
    const roles = body?.['roles'];
    if (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string') || roles.length > 32) {
      throw new BadRequestException('« roles » doit être une liste de clés de rôle');
    }
    const a = req.authCtx!;
    const outcome = await this.users.assignRoles(a.tenantId, a.userId, requireUuid(id, 'id'), roles as string[]);
    switch (outcome.kind) {
      case 'ok':
        return { assigned: true };
      case 'user_not_found':
        throw new HttpException('utilisateur introuvable', 404);
      case 'unknown_roles':
        throw new BadRequestException({ message: 'rôles inconnus', roles: outcome.roles });
      case 'escalation':
        throw new ForbiddenException({
          message: 'délégation refusée : rôle apportant une permission que vous ne détenez pas',
          permissions: outcome.permissions,
        });
    }
  }

  @Post(':id/revoke-sessions')
  @HttpCode(200)
  @RequirePermission('sessions.revoke')
  async revokeSessions(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ revoked: number }> {
    const a = req.authCtx!;
    return this.users.revokeUserSessions(a.tenantId, a.userId, requireUuid(id, 'id'));
  }
}
