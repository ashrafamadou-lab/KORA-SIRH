import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma.module';
import { AuthModule } from './auth/auth.module';
import { EmployeesModule } from './employees/employees.module';
import { AdminModule } from './admin/admin.module';
import { WorkflowModule } from './workflow/workflow.module';
import { ConfigModule } from './config/config.module';
import { NotifyModule } from './notify/notify.module';
import { OpenapiController } from './openapi/openapi.controller';

@Module({
  imports: [PrismaModule, AuthModule, EmployeesModule, AdminModule, WorkflowModule, ConfigModule, NotifyModule],
  controllers: [HealthController, OpenapiController],
})
export class AppModule {}
