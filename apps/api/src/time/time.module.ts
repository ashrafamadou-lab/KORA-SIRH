/**
 * E10 — Temps & pointage : horaires versionnés, rotations, collecte BRUTE
 * (append-only), normalisation, imports CSV/Excel idempotents (E10.1), puis
 * MOTEUR de calcul de présence — résultats versionnés, anomalies, recalcul
 * motivé, agrégats retraçables (E10.2). Les corrections manuelles et leur
 * circuit d'approbation sont E10.3 — rien ici.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { NotifyModule } from '../notify/notify.module';
import { SchedulesService } from './schedules.service';
import { SchedulesController } from './schedules.controller';
import { PunchesService } from './punches.service';
import { PunchImportService } from './punch-import.service';
import { PunchesController } from './punches.controller';
import { CalcService } from './calc.service';
import { CalcController } from './calc.controller';

@Module({
  imports: [AuthModule, RbacModule, NotifyModule],
  controllers: [SchedulesController, PunchesController, CalcController],
  providers: [SchedulesService, PunchesService, PunchImportService, CalcService],
})
export class TimeModule {}
