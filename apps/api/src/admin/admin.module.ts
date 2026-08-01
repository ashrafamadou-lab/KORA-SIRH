import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminRolesController } from './admin-roles.controller';
import { AdminUsersService } from './admin-users.service';

@Module({
  imports: [AuthModule, RbacModule],
  controllers: [AdminUsersController, AdminRolesController],
  providers: [AdminUsersService],
})
export class AdminModule {}
