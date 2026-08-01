import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AccountController } from './account.controller';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { AccountService } from './account.service';
import { BreachedPasswordService } from './breached-password.service';
import { SessionGuard } from './session.guard';

@Module({
  controllers: [AuthController, AccountController],
  providers: [AuthService, MfaService, AccountService, BreachedPasswordService, SessionGuard],
  exports: [AuthService, MfaService, AccountService, BreachedPasswordService, SessionGuard],
})
export class AuthModule {}
