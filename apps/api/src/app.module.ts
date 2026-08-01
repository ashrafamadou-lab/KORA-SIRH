import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma.module';
import { AuthModule } from './auth/auth.module';
import { EmployeesModule } from './employees/employees.module';
import { OpenapiController } from './openapi/openapi.controller';

@Module({
  imports: [PrismaModule, AuthModule, EmployeesModule],
  controllers: [HealthController, OpenapiController],
})
export class AppModule {}
