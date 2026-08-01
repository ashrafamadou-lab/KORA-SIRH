import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health(): Promise<{ status: string; database: string; time: string }> {
    let database = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      // état honnête : l'API répond, la base non
    }
    return { status: database === 'up' ? 'ok' : 'degraded', database, time: new Date().toISOString() };
  }
}
