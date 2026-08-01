import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { EmployeesController } from './employees.controller';

@Module({
  imports: [AuthModule, RbacModule],
  controllers: [EmployeesController],
})
export class EmployeesModule {}
