import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Client Prisma unique de l'application (rôle kora_app, NOBYPASSRLS).
 * Règle absolue (ADR-002) : tout accès aux données d'un tenant passe par withTenant(),
 * qui ouvre une transaction et pose `app.tenant_id` via set_config(..., true) — donc
 * borné à la transaction. Hors transaction, la RLS ne rend AUCUNE ligne tenant : un
 * oubli échoue fermé, il ne fuit pas.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error('withTenant : identifiant de tenant invalide');
    }
    return this.$transaction(async (tx) => {
      // $queryRaw (forme SELECT) — $executeRaw est réservé aux ordres sans résultat et
      // peut rejeter un SELECT selon les versions de Prisma.
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }

  /** Résolution du slug au login — seule lecture légitime avant tout contexte tenant (0007). */
  async resolveTenant(slug: string): Promise<string | null> {
    const rows = await this.$queryRaw<Array<{ id: string | null }>>`
      SELECT admin.resolve_tenant(${slug}) AS id`;
    return rows[0]?.id ?? null;
  }
}
