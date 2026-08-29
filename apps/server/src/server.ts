import { parseEnv } from './config/env.js';
import { buildApp } from './app.js';

async function main() {
  const env = parseEnv();
  const app = await buildApp({ env });

  const closeGracefully = async (signal: string) => {
    app.log.info(`Received ${signal}, closing server gracefully...`);
    try {
      await app.close();
      app.log.info('Server closed cleanly.');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => closeGracefully('SIGINT'));
  process.on('SIGTERM', () => closeGracefully('SIGTERM'));

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    app.log.info(`PaxFlux server running on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.fatal({ err }, 'Fatal error during startup');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled fatal error:', err);
  process.exit(1);
});
