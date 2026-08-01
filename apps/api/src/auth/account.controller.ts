import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccountService, type ActiveSession } from './account.service';
import { SessionGuard, type AuthenticatedRequest } from './session.guard';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new BadRequestException(`champ « ${field} » manquant ou invalide`);
  }
  return value;
}

/** Self-service de l'utilisateur connecté — jamais de jeton renvoyé, uniquement des métadonnées. */
@Controller('auth')
@UseGuards(SessionGuard)
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get('sessions')
  listSessions(@Req() req: AuthenticatedRequest): Promise<ActiveSession[]> {
    const a = req.authCtx!;
    return this.account.listSessions(a.tenantId, a.userId, a.sessionId);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeOne(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    if (!UUID_RE.test(id)) throw new BadRequestException('identifiant de session invalide');
    const a = req.authCtx!;
    const res = await this.account.revokeSession(a.tenantId, a.userId, id);
    if (res.kind === 'not_found') {
      // 404 générique : ne distingue pas « inexistante » de « à un autre utilisateur ».
      throw new HttpException('session introuvable', 404);
    }
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  async revokeOthers(@Req() req: AuthenticatedRequest): Promise<{ revoked: number }> {
    const a = req.authCtx!;
    return { revoked: await this.account.revokeOtherSessions(a.tenantId, a.userId, a.sessionId) };
  }

  @Post('password')
  @HttpCode(200)
  async changePassword(
    @Body() body: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ changed: true; otherSessionsRevoked: true }> {
    const currentPassword = requireString(body?.['currentPassword'], 'currentPassword', 512);
    const newPassword = requireString(body?.['newPassword'], 'newPassword', 512);
    const a = req.authCtx!;
    const outcome = await this.account.changePassword(
      a.tenantId,
      a.userId,
      a.email,
      currentPassword,
      newPassword,
      a.sessionId,
    );
    switch (outcome.kind) {
      case 'ok':
        return { changed: true, otherSessionsRevoked: true };
      case 'wrong_current':
        throw new HttpException('mot de passe actuel incorrect', 401);
      case 'policy':
        throw new BadRequestException({ message: 'mot de passe non conforme', issues: outcome.issues });
      case 'breached':
        throw new BadRequestException({ message: 'mot de passe présent dans une fuite connue', code: 'breached' });
      case 'breach_unavailable':
        // Mode fail-closed : indisponibilité du service de compromission = 503.
        throw new HttpException(
          { statusCode: 503, message: 'vérification de compromission indisponible — réessayer', code: 'breach_unavailable' },
          503,
        );
    }
  }
}
