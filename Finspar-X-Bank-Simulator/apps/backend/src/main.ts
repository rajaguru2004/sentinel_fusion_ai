import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

// BigInt is not JSON-serialisable by default. Emit paise as strings so the
// wire format never loses precision. The frontend formatINR() helper parses these.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Trust the reverse proxy so req.ip is the real client IP (from X-Forwarded-For),
  // not the proxy's — required for correct geo-IP country resolution in the fraud
  // gateway. `1` = trust one proxy hop; raise it if you sit behind more.
  app.set('trust proxy', 1);

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
    credentials: true,
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
