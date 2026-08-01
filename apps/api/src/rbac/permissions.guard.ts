import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma.service';
import type { AuthenticatedRequest } from '../auth/session.guard';
import { PERMISSION_METADATA_KEY } from './require-permission.decorator';
import {
  can,
  type PrincipalAccess,
  type ScopeType,
} from '../../../../packages/core/src/rbac.ts';

/**
 * Garde RBAC branchée sur la BASE (US-E2-01/02, tranche 2) : charge les permissions
 * (user_roles → role_permissions) et les portées (user_scopes) du principal, puis
 * évalue avec la logique de domaine @kora/core (`can`) — cumul de rôles = union,
 * AUCUNE permission sans portée couvrante (anti-élévation).
 * v1 : cible non typée par route → une action « de niveau tenant » exige la portée
 * tenant ; le filtrage fin par site/département arrive avec le module Organisation,
 * derrière la même interface. À placer APRÈS SessionGuard.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string | undefined>(
      PERMISSION_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const auth = req.authCtx;
    if (!auth) throw new UnauthorizedException('authentification requise');

    const loaded = await this.prisma.withTenant(auth.tenantId, async (tx) => {
      const permissions = await tx.$queryRaw<Array<{ permission_key: string }>>`
        SELECT rp.permission_key
          FROM admin.user_roles ur
          JOIN admin.role_permissions rp ON rp.role_id = ur.role_id
         WHERE ur.user_id = ${auth.userId}::uuid`;
      const scopes = await tx.$queryRaw<Array<{ scope_type: string; scope_ref: string | null }>>`
        SELECT scope_type, scope_ref
          FROM admin.user_scopes
         WHERE user_id = ${auth.userId}::uuid`;
      return { permissions, scopes };
    });

    const principal: PrincipalAccess = {
      roles: [{ roleKey: 'db', permissions: loaded.permissions.map((p) => p.permission_key) }],
      scopes: loaded.scopes.map((s) => ({ type: s.scope_type as ScopeType, ref: s.scope_ref })),
    };
    if (!can(principal, required)) {
      throw new ForbiddenException(`permission requise : ${required}`);
    }
    return true;
  }
}
