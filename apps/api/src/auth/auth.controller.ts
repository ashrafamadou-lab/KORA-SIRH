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
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthService, type LoginResult } from './auth.service';
import { MfaService } from './mfa.service';
import { SessionGuard, type AuthenticatedRequest } from './session.guard';
import { PrismaService } from '../prisma.service';
import { clearedSessionCookie, csrfTokenFor, sessionCookie, sessionTokenFromCookieHeader } from './csrf.util';
/**
 * Type structurel minimal de la réponse HTTP (seul setHeader est utilisé, pour
 * Set-Cookie). On n'importe PAS les types du paquet `express` : @types/express
 * n'est pas dans les dépendances et le lockfile ne doit pas bouger pour un type.
 */
interface ResponseAvecEntetes {
  setHeader(name: string, value: string): void;
}

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
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Connexion. Deux transports de jeton (clôture Phase 1) :
   *  - 'body' (défaut, clients d'API) : le jeton opaque est retourné dans la réponse ;
   *  - 'cookie' (PWA) : le jeton part UNIQUEMENT en cookie HttpOnly (SameSite=Strict,
   *    Path=/api, Secure si KORA_COOKIE_SECURE=1) — le JavaScript du navigateur ne le
   *    voit JAMAIS ; la réponse porte le jeton CSRF dérivé, à garder en mémoire.
   */
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest & { ip?: string },
    @Res({ passthrough: true }) res: ResponseAvecEntetes,
  ): Promise<LoginResult | Record<string, unknown>> {
    const tenantSlug = requireString(body?.['tenantSlug'], 'tenantSlug', 63);
    const email = requireString(body?.['email'], 'email', 320);
    const password = requireString(body?.['password'], 'password', 512);
    const mfaCode = optionalString(body?.['mfaCode'], 'mfaCode', 16);
    const transport = optionalString(body?.['tokenTransport'], 'tokenTransport', 10) ?? 'body';
    if (transport !== 'body' && transport !== 'cookie') {
      throw new BadRequestException('tokenTransport : body ou cookie');
    }
    const userAgentHeader = req.headers['user-agent'];
    const result = await this.auth.login({
      tenantSlug,
      email,
      password,
      mfaCode,
      ip: req.ip ?? null,
      userAgent: Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader ?? null,
    });
    if (transport === 'body') return result;
    const maxAge = (new Date(result.expiresAt).getTime() - Date.now()) / 1000;
    res.setHeader('Set-Cookie', sessionCookie(result.token, maxAge));
    // Le jeton de session ne quitte JAMAIS le canal cookie : réponse SANS token.
    return { expiresAt: result.expiresAt, user: result.user, csrfToken: csrfTokenFor(result.token) };
  }

  /**
   * Profil de session ENRICHI (E7) : permissions et portées RÉELLES (source de vérité
   * de la navigation PWA — l'affichage n'est jamais un contrôle de sécurité, chaque
   * route API garde ses propres gardes), identité du tenant et langue préférée.
   */
  @Get('me')
  @UseGuards(SessionGuard)
  async me(@Req() req: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const a = req.authCtx!;
    return this.prisma.withTenant(a.tenantId, async (tx) => {
      const perms = await tx.$queryRaw<Array<{ permission_key: string }>>`
        SELECT DISTINCT rp.permission_key FROM admin.user_roles ur
          JOIN admin.role_permissions rp ON rp.role_id = ur.role_id
         WHERE ur.user_id = ${a.userId}::uuid ORDER BY rp.permission_key`;
      const scopes = await tx.$queryRaw<Array<{ scope_type: string; scope_ref: string | null }>>`
        SELECT scope_type, scope_ref FROM admin.user_scopes WHERE user_id = ${a.userId}::uuid`;
      const roles = await tx.$queryRaw<Array<{ key: string; name: string }>>`
        SELECT r.key, r.name FROM admin.user_roles ur JOIN admin.roles r ON r.id = ur.role_id
         WHERE ur.user_id = ${a.userId}::uuid ORDER BY r.key`;
      const user = await tx.$queryRaw<Array<{ locale: string | null; mfa_enabled: boolean }>>`
        SELECT locale, mfa_enabled FROM admin.users WHERE id = ${a.userId}::uuid`;
      const tenant = await tx.$queryRaw<Array<{ slug: string; name: string }>>`
        SELECT slug, name FROM admin.tenants WHERE id = ${a.tenantId}::uuid`;
      // Auth par COOKIE : la PWA récupère ici son jeton CSRF (mémoire seule) au
      // démarrage — le jeton de session, lui, reste invisible du JavaScript.
      const cookieHeader = req.headers['cookie'];
      const cookieToken = req.authTokenSource === 'cookie'
        ? sessionTokenFromCookieHeader(Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)
        : null;
      return {
        tenantId: a.tenantId,
        userId: a.userId,
        sessionId: a.sessionId,
        email: a.email,
        permissions: perms.map((p) => p.permission_key),
        scopes: scopes.map((s) => ({ type: s.scope_type, ref: s.scope_ref })),
        roles,
        locale: user[0]?.locale ?? 'fr',
        mfaEnabled: user[0]?.mfa_enabled ?? false,
        tenant: tenant[0] ?? null,
        ...(cookieToken ? { csrfToken: csrfTokenFor(cookieToken) } : {}),
      };
    });
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: ResponseAvecEntetes,
  ): Promise<void> {
    const header = req.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    const cookieHeader = req.headers['cookie'];
    const token = value && value.startsWith('Bearer ')
      ? value.slice('Bearer '.length).trim()
      : sessionTokenFromCookieHeader(Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader) ?? '';
    // Le cookie meurt côté navigateur ET la session est révoquée côté serveur.
    res.setHeader('Set-Cookie', clearedSessionCookie());
    await this.auth.logout(token);
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
