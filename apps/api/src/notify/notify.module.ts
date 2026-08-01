import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { NotifyController } from './notify.controller';
import { NotifyAdminController } from './notify-admin.controller';
import { NotificationService } from './notification.service';

@Module({
  imports: [AuthModule, RbacModule],
  controllers: [NotifyController, NotifyAdminController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotifyModule {}
