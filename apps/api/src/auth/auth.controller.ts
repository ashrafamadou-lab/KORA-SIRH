import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthService, type LoginResult } from './auth.service';
import { MfaService } from './mfa.service';
import { SessionGuard, type AuthenticatedRequest } from './session.guard';

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new BadRequestException(`champ « ${field} » manquant ou invalide`);
  }
  return value;
}

function optionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new BadRequestException(`champ « ${field} » invalide`);
  }
  return value;
}

function badCode(): never {
  throw new HttpException({ statusCode: 401, message: 'code MFA invalide' }, 401);
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest & { ip?: string },
  ): Promise<LoginResult> {
    const tenantSlug = requireString(body?.['tenantSlug'], 'tenantSlug', 63);
    const email = requireString(body?.['email'], 'email', 320);
    const password = requireString(body?.['password'], 'password', 512);
    const mfaCode = optionalString(body?.['mfaCode'], 'mfaCode', 16);
    const userAgentHeader = req.headers['user-agent'];
    return this.auth.login({
      tenantSlug,
      email,
      password,
      mfaCode,
      ip: req.ip ?? null,
      userAgent: Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader ?? null,
    });
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['authCtx']> {
    return req.authCtx!;
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(@Req() req: AuthenticatedRequest): Promise<void> {
    const header = req.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    await this.auth.logout((value ?? '').slice('Bearer '.length).trim());
  }

  // ---------- MFA (US-E1-02) — session requise pour tout le cycle de vie ----------

  @Post('mfa/enroll')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async mfaEnroll(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ secret: string; otpauthUri: string }> {
    const auth = req.authCtx!;
    const outcome = await this.mfa.enroll(auth.tenantId, auth.userId);
    if (outcome.kind === 'already_enabled') {
      throw new ConflictException('MFA déjà activé — le désactiver avant un nouvel enrôlement');
    }
    return { secret: outcome.secret, otpauthUri: outcome.otpauthUri };
  }

  @Post('mfa/activate')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async mfaActivate(
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ recoveryCodes: string[] }> {
    const auth = req.authCtx!;
    const code = requireString(body?.['code'], 'code', 16);
    const outcome = await this.mfa.activate(auth.tenantId, auth.userId, code);
    if (outcome.kind === 'no_pending') {
      throw new ConflictException('aucun enrôlement MFA en attente');
    }
    if (outcome.kind === 'bad_code') badCode();
    return { recoveryCodes: outcome.recoveryCodes };
  }

  @Post('mfa/recovery-codes')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async mfaRotateCodes(
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ recoveryCodes: string[] }> {
    const auth = req.authCtx!;
    const code = requireString(body?.['code'], 'code', 16);
    const outcome = await this.mfa.regenerateRecoveryCodes(auth.tenantId, auth.userId, code);
    if (outcome.kind === 'not_enabled') throw new ConflictException('MFA non activé');
    if (outcome.kind === 'bad_code') badCode();
    return { recoveryCodes: outcome.recoveryCodes };
  }

  @Post('mfa/disable')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async mfaDisable(
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ disabled: true }> {
    const auth = req.authCtx!;
    const code = requireString(body?.['code'], 'code', 16);
    const outcome = await this.mfa.disable(auth.tenantId, auth.userId, code);
    if (outcome.kind === 'not_enabled') throw new ConflictException('MFA non activé');
    if (outcome.kind === 'bad_code') badCode();
    return { disabled: true };
  }
}
