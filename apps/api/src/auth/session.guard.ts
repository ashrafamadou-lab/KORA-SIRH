import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService, type AuthContext } from './auth.service';

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  authCtx?: AuthContext;
}

/**
 * Garde de session : Bearer k1.<tenant>.<aléa> → contexte authentifié sur la requête.
 * Toute vérification (empreinte, tenant, expiration absolue, inactivité, révocation)
 * est déléguée à AuthService.authenticate — une seule règle, un seul endroit.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || !value.startsWith('Bearer ')) {
      throw new UnauthorizedException('authentification requise');
    }
    req.authCtx = await this.auth.authenticate(value.slice('Bearer '.length).trim());
    return true;
  }
}
