/**
 * E10.1 — Temps & pointage : horaires versionnés, rotations, collecte BRUTE
 * (append-only), normalisation, imports CSV/Excel idempotents.
 * Le CALCUL (retards, absences, heures supplémentaires) est E10.2 — rien ici.
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

@Module({
  imports: [AuthModule, RbacModule, NotifyModule],
  controllers: [SchedulesController, PunchesController],
  providers: [SchedulesService, PunchesService, PunchImportService],
})
export class TimeModule {}
