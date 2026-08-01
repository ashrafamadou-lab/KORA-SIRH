import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { NotifyModule } from '../notify/notify.module';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';
import { OrgImportService } from './org-import.service';

@Module({
  imports: [AuthModule, RbacModule, WorkflowModule, NotifyModule],
  controllers: [OrgController],
  providers: [OrgService, OrgImportService],
  exports: [OrgService],
})
export class OrgModule {}
