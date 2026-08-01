import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthService, type LoginResult } from './auth.service';
import { SessionGuard, type AuthenticatedRequest } from './session.guard';

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new BadRequestException(`champ « ${field} » manquant ou invalide`);
  }
  return value;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest & { ip?: string },
  ): Promise<LoginResult> {
    const tenantSlug = requireString(body?.['tenantSlug'], 'tenantSlug', 63);
    const email = requireString(body?.['email'], 'email', 320);
    const password = requireString(body?.['password'], 'password', 512);
    const userAgentHeader = req.headers['user-agent'];
    return this.auth.login({
      tenantSlug,
      email,
      password,
      ip: req.ip ?? null,
      userAgent: Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader ?? null,
    });
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['authCtx']> {
    // authCtx est posé par SessionGuard — garanti présent ici.
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
}
