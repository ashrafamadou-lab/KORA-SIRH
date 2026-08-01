import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** Un seul client Prisma (un seul pool) pour toute l'application. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
