import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import path from "path";
import fs from "fs";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { Server as SocketIOServer } from "socket.io";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { setupUploadRoute } from "../uploadHandler";
import { setupLogoUploadRoute } from "../logoUploadHandler";
import { setupJournalRoute } from "../journalHandler";
import { setupAuthRoutes } from "../auth/authRoutes";
import { authMiddleware } from "../auth/authMiddleware";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.listen(port, () => {
      server.close(() => resolve(true));
    });

    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  const io = new SocketIOServer(server, {
    cors: {
      origin: process.env.SOCKET_CORS_ORIGIN || true,
      methods: ["GET", "POST"],
    },
  });

  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ limit: "100mb", extended: true }));

  // 🔐 ROTAS DE AUTH (LOGIN, ME, REQUEST-ACCESS)
  await setupAuthRoutes(app);

  registerOAuthRoutes(app);

  // 🔥 PROTEÇÃO INTELIGENTE (NÃO BLOQUEIA AUTH)
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth")) {
      return next(); // libera /api/auth/*
    }

    return authMiddleware(req, res, next); // protege resto
  });

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext: async (opts) => createContext(opts, io),
    })
  );

  io.on("connection", (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on("join", (sessionId: string) => {
      socket.join(sessionId);
      console.log(`Client ${socket.id} joined session ${sessionId}`);
    });

    socket.on("disconnect", () => {
      console.log(`Client disconnected: ${socket.id}`);
    });
  });

  setupUploadRoute(app);
  setupLogoUploadRoute(app);
  setupJournalRoute(app);

  app.use("/output", express.static(path.resolve("output")));
  app.use("/assets", express.static(path.resolve("assets")));
  app.use("/fonts", express.static(path.resolve("fonts")));
  app.use("/logos", express.static(path.resolve("logos")));

  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const uploadsDir = path.resolve("uploads");
  const outputDir = path.resolve("output");
  const tmpDir = path.resolve("tmp");

  for (const dir of [uploadsDir, outputDir, tmpDir]) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);

      for (const file of files) {
        try {
          fs.unlinkSync(path.join(dir, file));
        } catch {}
      }
    }
  }

  const preferredPort = parseInt(process.env.PORT || "3000", 10);
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  // Guarda a porta real (pode diferir de process.env.PORT se ela estava
  // ocupada) para uso interno, como requisições do Puppeteer ao próprio
  // servidor durante a geração do PDF do jornal.
  app.locals.actualPort = port;

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    console.log("Socket.io ready for real-time updates");
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
