/**
 * E11.1 + E11.2 — Module Congés & absences : référentiel, politiques versionnées,
 * ledger append-only des droits, acquisitions idempotentes, soldes par vue,
 * ajustements motivés (E3 pour les sensibles), import de reprise, DEMANDES ESS
 * versionnées (réservation/consommation par mouvements, circuits E3 distincts,
 * justificatifs cloisonnés), calendrier d'équipe.
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
import { LeaveRequestsService } from './requests.service';
import { LeaveIntegrationService } from './integration.service';
import { LeaveCloseService } from './close.service';
import { LeaveController } from './leave.controller';
import { LeaveRequestsController } from './requests.controller';
import { LeaveCloseController } from './close.controller';

@Module({
  imports: [AuthModule, RbacModule, NotifyModule, WorkflowModule, TimeModule],
  providers: [LeaveCatalogService, LeaveAccrualService, LeaveBalancesService, LeaveRequestsService, LeaveIntegrationService, LeaveCloseService],
  controllers: [LeaveController, LeaveRequestsController, LeaveCloseController],
})
export class LeaveModule {}
