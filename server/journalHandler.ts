import { Express, Request, Response } from "express";
import path from "path";
import fs from "fs";
import puppeteer, { Browser, Page } from "puppeteer-core";
import { PDFDocument } from "pdf-lib";

const OUTPUT_DIR = path.resolve("output");
const JOURNAL_WIDTH = 1080;
const FIXED_PAGE_HEIGHT = 1920;

type JournalPagePayload = {
  type: "cover" | "category" | "ad" | string;
  title?: string;
  html: string;
};

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sanitizeFileName(value: string): string {
  const safe =
    String(value || "jornal-diagramado")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .toLowerCase()
      .trim() || "jornal-diagramado";

  return safe.endsWith(".pdf") ? safe : `${safe}.pdf`;
}

function sanitizeTempName(value: string): string {
  return (
    String(value || "pagina")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .toLowerCase()
      .trim() || "pagina"
  );
}

function getExecutablePath() {
  return (
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_BIN ||
    process.env.CHROMIUM_PATH ||
    "/usr/bin/chromium"
  );
}

async function launchBrowser(): Promise<Browser> {
  const executablePath = getExecutablePath();

  console.log(`[JournalHandler] Launching browser with: ${executablePath}`);

  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=Translate,BackForwardCache,AcceptCHFrame",
      "--no-first-run",
      "--no-zygote",
    ],
  });
}

function buildPageHtml(pageHtml: string, baseUrl: string) {
  const safeBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

  return `<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <base href="${safeBaseUrl}" />
  <style>
    @font-face {
      font-family: 'Inter';
      src: url('/fonts/Inter-Regular.ttf') format('truetype');
      font-weight: 400;
    }
    @font-face {
      font-family: 'Inter';
      src: url('/fonts/Inter-Bold.ttf') format('truetype');
      font-weight: 700;
    }
    @font-face {
      font-family: 'Inter';
      src: url('/fonts/Inter-Black.ttf') format('truetype');
      font-weight: 900;
    }

    html, body {
      width: ${JOURNAL_WIDTH}px !important;
      min-width: ${JOURNAL_WIDTH}px !important;
      max-width: ${JOURNAL_WIDTH}px !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: hidden !important;
      background: #ffffff !important;
      font-family: Inter, Arial, sans-serif;
      color: #111111;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    * {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    img {
      max-width: none;
    }

    .journal-page-label {
      display: none !important;
    }

    .journal-page,
    .journal-cover-page,
    .journal-ad-page {
      width: ${JOURNAL_WIDTH}px !important;
      min-width: ${JOURNAL_WIDTH}px !important;
      max-width: ${JOURNAL_WIDTH}px !important;
      height: ${FIXED_PAGE_HEIGHT}px !important;
      min-height: ${FIXED_PAGE_HEIGHT}px !important;
      max-height: ${FIXED_PAGE_HEIGHT}px !important;
      margin: 0 !important;
      overflow: hidden !important;
      box-shadow: none !important;
      break-after: auto !important;
      page-break-after: auto !important;
    }

    .journal-category-page,
    [data-journal-page="category"] {
      width: ${JOURNAL_WIDTH}px !important;
      min-width: ${JOURNAL_WIDTH}px !important;
      max-width: ${JOURNAL_WIDTH}px !important;
      height: auto !important;
      min-height: 0 !important;
      max-height: ${FIXED_PAGE_HEIGHT}px !important;
      margin: 0 !important;
      overflow: hidden !important;
      box-shadow: none !important;
      break-after: auto !important;
      page-break-after: auto !important;
    }

    .journal-card-wrap {
      overflow: hidden !important;
      flex-shrink: 0 !important;
    }

    .journal-card-shadow-host {
      display: block !important;
      width: 700px !important;
      height: 1058px !important;
      overflow: hidden !important;
      background: #ffffff !important;
      transform-origin: top left !important;
    }
  </style>
</head>
<body>
  ${pageHtml}
</body>
</html>`;
}

async function waitForPageReady(page: Page) {
  await page.evaluate(async () => {
    try {
      // @ts-ignore
      if (document.fonts?.ready) await document.fonts.ready;

      const images = Array.from(document.images);

      await Promise.all(
        images.map((img) => {
          if (img.complete) return Promise.resolve();

          return new Promise<void>((resolve) => {
            img.onload = () => resolve();
            img.onerror = () => resolve();
            setTimeout(resolve, 5000);
          });
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 400));
    } catch (error) {
      console.error("[JournalHandler][waitForPageReady]", error);
    }
  });
}



async function getPdfPageHeight(page: Page, pageType: string) {
  if (pageType === "cover" || pageType === "ad") {
    return FIXED_PAGE_HEIGHT;
  }

  const measuredHeight = await page.evaluate(() => {
    const pageElement = document.querySelector("[data-journal-page]") as HTMLElement | null;

    if (pageElement) {
      const rect = pageElement.getBoundingClientRect();
      return Math.ceil(Math.max(pageElement.scrollHeight, pageElement.offsetHeight, rect.height));
    }

    const body = document.body;
    const html = document.documentElement;

    return Math.ceil(
      Math.max(
        body.scrollHeight,
        body.offsetHeight,
        html.scrollHeight,
        html.offsetHeight
      )
    );
  });

  return Math.min(Math.max(measuredHeight || 1, 1), FIXED_PAGE_HEIGHT);
}

async function renderSinglePagePdf(
  browser: Browser,
  journalPage: JournalPagePayload,
  outputPath: string,
  baseUrl: string
) {
  const page = await browser.newPage();

  try {
    page.on("console", (msg) => {
      const text = msg.text();
      if (text.toLowerCase().includes("erro") || text.toLowerCase().includes("error")) {
        console.log(`[JournalHandler][console][${journalPage.type}] ${text}`);
      }
    });

    page.on("pageerror", (error) => {
      console.error(`[JournalHandler][pageerror][${journalPage.type}]`, error);
    });

    await page.setViewport({
      width: JOURNAL_WIDTH,
      height: FIXED_PAGE_HEIGHT,
      deviceScaleFactor: 1,
    });

    await page.setContent(buildPageHtml(journalPage.html, baseUrl), {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

    await waitForPageReady(page);

    const finalHeight = await getPdfPageHeight(page, journalPage.type);

    await page.setViewport({
      width: JOURNAL_WIDTH,
      height: finalHeight,
      deviceScaleFactor: 1,
    });

    await page.pdf({
      path: outputPath,
      width: `${JOURNAL_WIDTH}px`,
      height: `${finalHeight}px`,
      printBackground: true,
      preferCSSPageSize: false,
      margin: {
        top: "0px",
        right: "0px",
        bottom: "0px",
        left: "0px",
      },
      timeout: 120000,
    });
  } finally {
    await page.close().catch(() => {});
  }
}

async function mergePdfFiles(pdfPaths: string[], finalPdfPath: string) {
  const finalPdf = await PDFDocument.create();

  for (const pdfPath of pdfPaths) {
    const bytes = fs.readFileSync(pdfPath);
    const sourcePdf = await PDFDocument.load(bytes);
    const copiedPages = await finalPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());

    copiedPages.forEach((copiedPage) => {
      finalPdf.addPage(copiedPage);
    });
  }

  const finalBytes = await finalPdf.save();
  fs.writeFileSync(finalPdfPath, finalBytes);
}

export function setupJournalRoute(app: Express) {
  ensureDir(OUTPUT_DIR);

  app.post("/api/journal/pdf", async (req: Request, res: Response) => {
    let browser: Browser | null = null;

    try {
      const pages = Array.isArray(req.body?.pages)
        ? (req.body.pages as JournalPagePayload[])
        : [];

      const legacyHtml = String(req.body?.html || "");
      const jobId = String(req.body?.jobId || `journal_${Date.now()}`);
      const requestedFileName = String(req.body?.fileName || "jornal-diagramado.pdf");

      const normalizedPages: JournalPagePayload[] = pages.length
        ? pages
        : legacyHtml.trim()
          ? [{ type: "category", title: "Jornal", html: legacyHtml }]
          : [];

      if (!normalizedPages.length) {
        return res.status(400).json({
          success: false,
          error: "Nenhuma página do jornal foi recebida pelo servidor.",
        });
      }

      for (const [index, pageData] of normalizedPages.entries()) {
        if (!pageData?.html || !String(pageData.html).trim()) {
          return res.status(400).json({
            success: false,
            error: `A página ${index + 1} do jornal está vazia.`,
          });
        }
      }

      const jobDir = path.join(OUTPUT_DIR, jobId);
      const tempDir = path.join(jobDir, "journal-temp");
      ensureDir(jobDir);
      ensureDir(tempDir);

      const pdfName = sanitizeFileName(requestedFileName.replace(/\.zip$/i, ""));
      const finalPdfPath = path.join(jobDir, pdfName);

      browser = await launchBrowser();

      const protocol = req.protocol || "http";
      const host = req.get("host") || `localhost:${process.env.PORT || "3000"}`;
      const baseUrl = `${protocol}://${host}`;

      const tempPdfPaths: string[] = [];

      for (const [index, journalPage] of normalizedPages.entries()) {
        const safeType = sanitizeTempName(journalPage.type || "pagina");
        const safeTitle = sanitizeTempName(journalPage.title || String(index + 1));
        const tempPdfPath = path.join(
          tempDir,
          `${String(index + 1).padStart(3, "0")}_${safeType}_${safeTitle}.pdf`
        );

        console.log(
          `[JournalHandler] Renderizando página ${index + 1}/${normalizedPages.length}: ${journalPage.type} ${journalPage.title || ""}`
        );

        await renderSinglePagePdf(browser, journalPage, tempPdfPath, baseUrl);
        tempPdfPaths.push(tempPdfPath);
      }

      await mergePdfFiles(tempPdfPaths, finalPdfPath);

      return res.json({
        success: true,
        pdfPath: finalPdfPath,
        pdfUrl: `/output/${jobId}/${pdfName}`,
        downloadUrl: `/api/journal/download?pdfPath=${encodeURIComponent(finalPdfPath)}`,
        fileName: pdfName,
        pageCount: normalizedPages.length,
      });
    } catch (error) {
      console.error("[JournalHandler] Erro ao gerar PDF do jornal:", error);

      return res.status(500).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Erro ao gerar PDF do jornal diagramado.",
      });
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  });

  app.get("/api/journal/download", async (req: Request, res: Response) => {
    try {
      const pdfPath = String(req.query?.pdfPath || "");

      if (!pdfPath) {
        return res.status(400).json({
          success: false,
          error: "Caminho do PDF não informado.",
        });
      }

      const resolvedPath = path.resolve(pdfPath);
      const resolvedOutputDir = path.resolve(OUTPUT_DIR);

      if (!resolvedPath.startsWith(resolvedOutputDir)) {
        return res.status(403).json({
          success: false,
          error: "Acesso negado ao arquivo solicitado.",
        });
      }

      if (!fs.existsSync(resolvedPath)) {
        return res.status(404).json({
          success: false,
          error: "PDF não encontrado.",
        });
      }

      const fileName = path.basename(resolvedPath);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

      return res.download(resolvedPath, fileName);
    } catch (error) {
      console.error("[JournalHandler] Erro ao baixar PDF do jornal:", error);

      return res.status(500).json({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Erro ao baixar PDF do jornal diagramado.",
      });
    }
  });
}
