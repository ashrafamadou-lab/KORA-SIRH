/**
 * E11.1 — Module Congés & absences : référentiel, politiques versionnées,
 * ledger append-only des droits, acquisitions idempotentes, soldes par vue,
 * ajustements motivés (E3 pour les sensibles), import de reprise.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { NotifyModule } from '../notify/notify.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { TimeModule } from '../time/time.module';
import { LeaveCatalogService } from './catalog.service';
import { LeaveAccrualService } from './accrual.service';
import { LeaveBalancesService } from './balances.service';
import { LeaveController } from './leave.controller';

@Module({
  imports: [AuthModule, RbacModule, NotifyModule, WorkflowModule, TimeModule],
  providers: [LeaveCatalogService, LeaveAccrualService, LeaveBalancesService],
  controllers: [LeaveController],
})
export class LeaveModule {}
