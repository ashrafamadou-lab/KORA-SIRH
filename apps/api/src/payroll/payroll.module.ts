/**
 * E12.1 — Module Paie : référentiel de rémunération, rubriques versionnées à
 * grammaire fermée, moteur de calcul BRUT reproductible consommant les clôtures
 * E10 et E11. Aucune valeur légale ici : tout vient d'E4 à la date de paie.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { NotifyModule } from '../notify/notify.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { PayrollCatalogService } from './catalog.service';
import { PayrollCalcService } from './calc.service';
import { PayrollController } from './payroll.controller';

@Module({
  imports: [AuthModule, RbacModule, NotifyModule, WorkflowModule],
  providers: [PayrollCatalogService, PayrollCalcService],
  controllers: [PayrollController],
})
export class PayrollModule {}
