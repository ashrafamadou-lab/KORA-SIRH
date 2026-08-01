import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { NotifyModule } from '../notify/notify.module';
import { HrAdminController, HrController } from './hr.controller';
import { HrService } from './hr.service';
import { HrImportService } from './hr-import.service';

/** Core HR (E9) — remplace le module « employees » minimal des tranches 1-2. */
@Module({
  imports: [AuthModule, RbacModule, WorkflowModule, NotifyModule],
  controllers: [HrController, HrAdminController],
  providers: [HrService, HrImportService],
  exports: [HrService],
})
export class HrModule {}
