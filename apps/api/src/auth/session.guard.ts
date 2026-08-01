import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService, type AuthContext } from './auth.service';
import { CSRF_HEADER, csrfTokenValid, sessionTokenFromCookieHeader } from './csrf.util';

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  authCtx?: AuthContext;
  /** Provenance du jeton — 'cookie' déclenche l'exigence CSRF sur les écritures. */
  authTokenSource?: 'bearer' | 'cookie';
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Garde de session : Bearer k1.<tenant>.<aléa> OU cookie HttpOnly kora_session
 * (clôture Phase 1 — le navigateur ne voit jamais le jeton). Toute vérification
 * (empreinte, tenant, expiration absolue, inactivité, révocation) reste déléguée à
 * AuthService.authenticate — une seule règle, un seul endroit.
 * CSRF : l'authentification PAR COOKIE exige l'entête X-KORA-CSRF (dérivé HMAC du
 * jeton, comparaison à temps constant) sur toute méthode d'écriture. L'authentification
 * Bearer n'est pas CSRF-able : rien ne change pour les clients d'API (E1→E9).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers['authorization'];
    const bearer = Array.isArray(header) ? header[0] : header;

    let token: string;
    let source: 'bearer' | 'cookie';
    if (bearer && bearer.startsWith('Bearer ')) {
      token = bearer.slice('Bearer '.length).trim();
      source = 'bearer';
    } else {
      const cookieHeader = req.headers['cookie'];
      const fromCookie = sessionTokenFromCookieHeader(Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader);
      if (!fromCookie) throw new UnauthorizedException('authentification requise');
      token = fromCookie;
      source = 'cookie';
    }

    if (source === 'cookie' && WRITE_METHODS.has((req.method ?? 'GET').toUpperCase())) {
      const presented = req.headers[CSRF_HEADER];
      const value = Array.isArray(presented) ? presented[0] : presented;
      if (!csrfTokenValid(token, value)) {
        throw new ForbiddenException('protection CSRF : entête X-KORA-CSRF requis et valide');
      }
    }

    req.authCtx = await this.auth.authenticate(token);
    req.authTokenSource = source;
    return true;
  }
}
