import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';

/**
 * Catalogue des rôles du tenant (E7) — LECTURE seule, pour l'écran d'administration
 * des utilisateurs (affectation de rôles bornée aux permissions de l'acteur : la règle
 * anti-élévation reste appliquée par POST /admin/users/:id/roles, jamais ici).
 */
@Controller('admin/roles')
@UseGuards(SessionGuard, PermissionsGuard)
export class AdminRolesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission('users.view')
  list(@Req() req: AuthenticatedRequest): Promise<unknown[]> {
    return this.prisma.withTenant(req.authCtx!.tenantId, (tx) =>
      tx.$queryRaw<Array<Record<string, unknown>>>`
        SELECT r.id, r.key, r.name, r.is_system AS "isSystem",
               coalesce(array_agg(rp.permission_key ORDER BY rp.permission_key)
                        FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions
          FROM admin.roles r
          LEFT JOIN admin.role_permissions rp ON rp.role_id = r.id
         GROUP BY r.id, r.key, r.name, r.is_system
         ORDER BY r.key`,
    );
  }
}
