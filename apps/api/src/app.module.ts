import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma.module';
import { AuthModule } from './auth/auth.module';
import { HrModule } from './hr/hr.module';
import { AdminModule } from './admin/admin.module';
import { WorkflowModule } from './workflow/workflow.module';
import { ConfigModule } from './config/config.module';
import { NotifyModule } from './notify/notify.module';
import { AuditModule } from './audit/audit.module';
import { OrgModule } from './org/org.module';
import { TimeModule } from './time/time.module';
import { LeaveModule } from './leave/leave.module';
import { OpenapiController } from './openapi/openapi.controller';

@Module({
  imports: [PrismaModule, AuthModule, HrModule, AdminModule, WorkflowModule, ConfigModule, NotifyModule, AuditModule, OrgModule, TimeModule, LeaveModule],
  controllers: [HealthController, OpenapiController],
})
export class AppModule {}
