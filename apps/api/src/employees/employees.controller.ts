import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SessionGuard, type AuthenticatedRequest } from '../auth/session.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';

interface EmployeeListItem {
  id: string;
  matricule: string;
  firstName: string;
  lastName: string;
  status: string;
}

/**
 * Première surface métier protégée : session + permission `employees.view` chargée en
 * base + RLS PostgreSQL — trois barrières indépendantes. Liste volontairement minimale
 * (le module Core HR complet, avec pagination par curseur et filtrage par portée fine,
 * est la prochaine tranche — Blueprint FR-CORE).
 */
@Controller('employees')
@UseGuards(SessionGuard, PermissionsGuard)
export class EmployeesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermission('employees.view')
  async list(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ items: EmployeeListItem[]; count: number; limit: number }> {
    const auth = req.authCtx!;
    const items = await this.prisma.withTenant(auth.tenantId, (tx) =>
      tx.$queryRaw<EmployeeListItem[]>`
        SELECT id, matricule,
               first_name AS "firstName",
               last_name  AS "lastName",
               status
          FROM core.employees
         WHERE deleted_at IS NULL
         ORDER BY matricule
         LIMIT 100`,
    );
    return { items, count: items.length, limit: 100 };
  }
}
