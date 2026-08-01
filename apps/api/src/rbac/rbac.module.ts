import { Module } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';

@Module({
  providers: [PermissionsGuard],
  exports: [PermissionsGuard],
})
export class RbacModule {}
