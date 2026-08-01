import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api/v1');
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
