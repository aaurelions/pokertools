import { buildApp } from "./app.js";
import { config } from "./config.js";

async function start() {
  const app = await buildApp();

  try {
    await app.listen({
      port: config.PORT,
      host: config.HOST,
    });

    console.log(`
      🃏 @pokertools/api v1.0.0
      -------------------------
      🌍 Server: http://${config.HOST}:${config.PORT}
      📚 Docs:   http://${config.HOST}:${config.PORT}/docs
      🔌 Redis:  ${config.REDIS_URL}
      🐘 DB:     Connected
      🎮 Ready to play poker!
    `);

    // Graceful shutdown
    const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

    for (const signal of signals) {
      process.on(signal, () => {
        console.log(`\n🛑 Received ${signal}, starting graceful shutdown...`);
        void app.close().then(() => {
          console.log("👋 Shutdown complete.");
          process.exit(0);
        });
      });
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void start();
