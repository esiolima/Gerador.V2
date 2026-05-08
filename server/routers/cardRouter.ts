```ts
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { CardGenerator } from "../cardGenerator";
import path from "path";
import fs from "fs";
import { TRPCError } from "@trpc/server";

const activeGenerators = new Map<string, CardGenerator>();

export const cardRouter = router({
  generateCards: publicProcedure
    .input(
      z.object({
        filePath: z.string(),
        sessionId: z.string(),
        originalFileName: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { filePath, sessionId, originalFileName } = input;

      if (!fs.existsSync(filePath)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Arquivo não encontrado.",
        });
      }

      if (!filePath.toLowerCase().endsWith(".xlsx")) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Apenas arquivos .xlsx são suportados.",
        });
      }

      const generator = new CardGenerator();

      activeGenerators.set(sessionId, generator);

      try {
        await generator.initialize();

        generator.on("progress", (progress) => {
          ctx.io?.to(sessionId).emit("progress", progress);
        });

        const result = await generator.generateCards(
          filePath,
          originalFileName
        );

        return {
          success: true,
          zipPath: result.zipPath,
          zipName: result.zipName,
          fileName: path.basename(result.zipPath),
          jobId: result.jobId,
          cards: result.cards,
          totalRows: result.totalRows,
          processedRows: result.processedRows,
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Erro ao processar a planilha.";

        console.error("====================================");
        console.error("ERRO NO PROCESSAMENTO DO JORNAL");
        console.error(message);
        console.error(error);
        console.error("====================================");

        ctx.io?.to(sessionId).emit("progress", {
          processed: 0,
          total: 0,
          percentage: 100,
          currentCard: "Erro na planilha",
          stage: "erro",
          detail: message,
          updatedAt: new Date().toISOString(),
        });

        ctx.io?.to(sessionId).emit("error", {
          success: false,
          message,
        });

        throw new TRPCError({
          code: "BAD_REQUEST",
          message,
        });
      } finally {
        await generator.close().catch(() => {});
        activeGenerators.delete(sessionId);
      }
    }),

  downloadZip: publicProcedure
    .input(
      z.object({
        zipPath: z.string(),
      })
    )
    .query(async ({ input }) => {
      const { zipPath } = input;

      const outputDir = path.resolve("output");
      const resolvedPath = path.resolve(zipPath);

      if (!resolvedPath.startsWith(outputDir)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Acesso negado.",
        });
      }

      if (!fs.existsSync(resolvedPath)) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Arquivo não encontrado.",
        });
      }

      return {
        success: true,
        exists: true,
      };
    }),
});
```
