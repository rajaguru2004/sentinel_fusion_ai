try {
  process.loadEnvFile?.();
} catch {
  // Ignore if .env is missing or already loaded
}

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ExpressAdapter, type NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { assertSafeConfig } from './common/assert-safe-config';
import { CORRELATION_HEADER } from './common/correlation';
import { CSRF_HEADER } from './common/csrf';

// BigInt is not JSON-serialisable by default. Emit paise as strings so the
// wire format never loses precision. The frontend formatINR() helper parses these.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

async function bootstrap(): Promise<void> {
  // Refuse to boot production with a demo affordance left on; warn in dev so the
  // posture is visible on every start.
  assertSafeConfig();

  // The adapter is passed explicitly rather than left to Nest's implicit driver
  // lookup. That lookup resolves "@nestjs/platform-express" from inside
  // @nestjs/core's own directory, which breaks whenever npm hoists the two
  // packages to different levels of a workspace tree — a layout npm chooses on
  // its own and re-chooses on every install. Naming the adapter here resolves it
  // from this file's module scope instead, so the boot no longer depends on
  // where the installer happened to put things.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, new ExpressAdapter());

  // Trust the reverse proxy so req.ip is the real client IP (from X-Forwarded-For),
  // not the proxy's — required for correct geo-IP country resolution in the fraud
  // gateway AND for the rate limiter to key on the caller rather than the proxy.
  // `1` = trust one proxy hop; raise it if you sit behind more.
  app.set('trust proxy', 1);

  // Security headers (§2). CSP is left off: this process serves only JSON and the
  // Swagger UI, which needs inline scripts — a CSP here would buy nothing and
  // break the docs. The frontend sets its own CSP for the pages that need one.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

  // The JWT now travels in an httpOnly cookie (§4); this parses it for the guard.
  app.use(cookieParser());

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
    // Required for the browser to send the session cookie cross-origin.
    credentials: true,
    // Browsers only expose these to JS on a cross-origin response if listed.
    allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER, CORRELATION_HEADER, 'X-Device-Fingerprint', 'X-Mock-Country'],
    exposedHeaders: [CORRELATION_HEADER],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Bank of Maharashtra Banking Simulator API')
    .setDescription('Indian corporate internet-banking simulator')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Bank of Maharashtra backend listening on http://localhost:${port}/api`);
}

void bootstrap();
