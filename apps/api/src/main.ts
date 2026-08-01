import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api/v1');
  // En-têtes de sécurité de l'API (clôture Phase 1) — appliqués par le serveur
  // RÉELLEMENT testé, pas seulement documentés. L'API ne sert que du JSON : CSP
  // « rien », anti-embarquement, anti-sniffing, et JAMAIS de cache navigateur/proxy
  // sur des données RH (no-store).
  app.use((_req: unknown, res: { setHeader(n: string, v: string): void }, next: () => void) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableShutdownHooks();
  return app;
}

/* c8 ignore start */
if (require.main === module) {
  createApp()
    .then((app) => app.listen(Number(process.env.PORT ?? 3000)))
    .then(() => console.log(`KORA API démarrée sur le port ${process.env.PORT ?? 3000}`))
    .catch((err) => {
      console.error('Échec du démarrage de l’API', err);
      process.exit(1);
    });
}
/* c8 ignore stop */
