import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { SessionGuard } from './session.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, MfaService, SessionGuard],
  exports: [AuthService, MfaService, SessionGuard],
})
export class AuthModule {}
