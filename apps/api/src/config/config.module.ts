import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { ConfigController } from './config.controller';
import { ConfigService } from './config.service';

@Module({
  imports: [AuthModule, RbacModule, WorkflowModule],
  controllers: [ConfigController],
  providers: [ConfigService],
})
export class ConfigModule {}
