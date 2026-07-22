import { Express, Request, Response } from "express";
import path from "path";
import fs from "fs";
import puppeteer, { Browser, Page } from "puppeteer-core";
import { PDFDocument } from "pdf-lib";

const OUTPUT_DIR = path.resolve("output");
const FONTS_DIR = path.resolve("fonts");
const JOURNAL_WIDTH = 1080;
const FIXED_PAGE_HEIGHT = 1920;
const CARD_WIDTH = 302.78;
const CARD_HEIGHT_PX = 458;
const GRID_GAP = 16;
const GRID_PADDING_X = 40;
const GRID_PADDING_Y_TOP = 20;
const GRID_PADDING_Y_BOTTOM = 36;
const THREE_CARDS_WIDTH = 3 * CARD_WIDTH + 2 * GRID_GAP;

const fontBase64Cache = new Map<string, string>();

function getFontMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".otf") return "font/otf";
  if (ext === ".woff") return "font/woff";
  if (ext === ".woff2") return "font/woff2";
  return "font/truetype";
}

// Substitui qualquer url('.../fonts/arquivo.ttf') por uma data URI em base64,
// lida diretamente do disco. Isso elimina qualquer dependência de rede
// (HTTP/loopback) para carregar fontes durante a geração do PDF — a fonte
// nunca falha silenciosamente por causa de proxy, porta dinâmica ou o
// container não conseguir acessar a própria URL pública.
function embedFontsAsBase64(html: string): string {
  return html.replace(
    /url\((['"]?)(?:\.\.\/|\/)*fonts\/([^'")]+)\1\)/g,
    (match, quote, rawFileName) => {
      const fileName = decodeURIComponent(rawFileName);

      try {
        let base64 = fontBase64Cache.get(fileName);

        if (!base64) {
          const filePath = path.join(FONTS_DIR, fileName);
          const fileBuffer = fs.readFileSync(filePath);
          base64 = fileBuffer.toString("base64");
          fontBase64Cache.set(fileName, base64);
        }

        const mimeType = getFontMimeType(fileName);
        return `url("data:${mimeType};base64,${base64}")`;
      } catch (error) {
        console.error(`[JournalHandler] Falha ao embutir fonte "${fileName}":`, error);
        return match;
      }
    }
  );
}

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
    timeout: 180000,
    protocolTimeout: 180000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--font-render-hinting=none",
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
      font-family: 'Segoe UI';
      src: url('/fonts/Segoe UI.ttf') format('truetype');
      font-weight: 400;
    }
    @font-face {
      font-family: 'Segoe UI';
      src: url('/fonts/Segoe UI Bold.ttf') format('truetype');
      font-weight: 700;
    }
    @font-face {
      font-family: 'Segoe UI';
      src: url('/fonts/segoe-ui-black.ttf') format('truetype');
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
      font-family: 'Segoe UI', Arial, sans-serif;
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
      margin: 0 !important;
      overflow: hidden !important;
      box-shadow: none !important;
      break-after: auto !important;
      page-break-after: auto !important;
    }

    .journal-root,
    .journal-page,
    .journal-category-page,
    [data-journal-page] {
      width: ${JOURNAL_WIDTH}px !important;
      min-width: ${JOURNAL_WIDTH}px !important;
      max-width: ${JOURNAL_WIDTH}px !important;
    }

    .journal-card-wrap {
      overflow: hidden !important;
      flex-shrink: 0 !important;
    }

    .journal-category-bar {
      position: relative !important;
      left: 0 !important;
      right: 0 !important;
      margin-left: auto !important;
      margin-right: auto !important;
      box-sizing: border-box !important;
    }

    .journal-grid {
      display: flex !important;
      flex-wrap: wrap !important;
      justify-content: center !important;
      gap: 16px !important;
      padding: 20px 40px 36px 40px !important;
      box-sizing: border-box !important;
      align-items: flex-start !important;
      align-content: flex-start !important;
      width: ${JOURNAL_WIDTH}px !important;
    }

    .journal-grid::after {
      content: '' !important;
      flex: 1 1 ${THREE_CARDS_WIDTH}px !important;
      visibility: hidden !important;
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
  try {
    // Aguarda que as fontes estejam carregadas (já embutidas em base64).
    await page.evaluate(async () => {
      // @ts-ignore
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }
    });
  } catch (error) {
    // Fontes já embutidas; ignorar falhas silenciosamente.
  }

  // Pausa curta para garantir que o CSS grid tenha calculado o layout.
  await new Promise((resolve) => setTimeout(resolve, 300));
}



async function getPdfPageHeight(page: Page, pageType: string) {
  if (pageType === "cover" || pageType === "ad") {
    return FIXED_PAGE_HEIGHT;
  }

  // Medir a altura real do elemento renderizado no navegador.
  const measuredHeight = await page.evaluate(() => {
    const pageElement = document.querySelector('[data-journal-page="category"]')
      || document.querySelector('.journal-category-page')
      || document.querySelector('[data-journal-page]');

    if (pageElement) {
      return Math.ceil(Math.max(
        pageElement.scrollHeight,
        pageElement.offsetHeight,
        pageElement.getBoundingClientRect().height
      ));
    }

    // Fallback: usar o body.
    const body = document.body;
    const html = document.documentElement;
    return Math.ceil(Math.max(
      body.scrollHeight,
      body.offsetHeight,
      html.scrollHeight,
      html.offsetHeight
    ));
  });

  // Altura mínima igual à capa para uniformidade visual.
  const finalHeight = Math.max(FIXED_PAGE_HEIGHT, measuredHeight);

  return Math.min(Math.ceil(finalHeight), 6000);
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

    // Escreve o HTML em arquivo temporário e carrega via file:// para evitar
    // timeout de setContent em payload grande (base64 de imagens, shadow DOM, etc.).
    const tempHtmlFile = outputPath.replace(/\.pdf$/, ".html");
    fs.writeFileSync(tempHtmlFile, embedFontsAsBase64(buildPageHtml(journalPage.html, baseUrl)), "utf-8");

    await page.setViewport({
      width: JOURNAL_WIDTH,
      height: FIXED_PAGE_HEIGHT,
      deviceScaleFactor: 1,
    });

    await page.goto(`file://${tempHtmlFile}`, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    await waitForPageReady(page);

    const finalHeight = await getPdfPageHeight(page, journalPage.type);

    // Garante valores inteiros para evitar erro int32 do protocolo.
    const safeHeight = Math.ceil(finalHeight);
    const safeWidth = Math.ceil(JOURNAL_WIDTH);

    await page.setViewport({
      width: safeWidth,
      height: safeHeight,
      deviceScaleFactor: 1,
    });
// Detecta o tipo de página pelo próprio HTML
const htmlContent = await page.content();

const isCover = htmlContent.includes("journal-cover");
const isAdPage = htmlContent.includes("journal-ad-page");
const isCardsPage = htmlContent.includes("journal-cards-page");

// Largura fixa para todas as páginas
const widthPx = 1080;

// Altura depende do tipo da página
let heightPx = 1920; // padrão para capa e anúncios

if (isCardsPage) {
  // mede a altura real do HTML
  const realHeight = await page.evaluate(() => document.body.scrollHeight);

  // nunca maior que 1920
  heightPx = Math.min(realHeight, 1920);
}

// aplica viewport
await page.setViewport({
  width: widthPx,
  height: heightPx,
  deviceScaleFactor: 1,
});

// gera o PDF
await page.pdf({
  path: outputPath,
  width: `${widthPx}px`,
  height: `${heightPx}px`,
  printBackground: true,
  preferCSSPageSize: false,
  margin: {
    top: "0px",
    right: "0px",
    bottom: "0px",
    left: "0px",
  },
  timeout: 180000,
});

// mantém o cleanup do arquivo temporário
try {
  fs.unlinkSync(tempHtmlFile);
} catch (err) {
  console.error("Erro ao remover arquivo temporário:", err);
} finally {
  await page.close().catch(() => {});
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

      // O Puppeteer roda no mesmo container do servidor Express: usar o
      // endereço local (loopback) evita depender de o container conseguir
      // acessar sua própria URL pública pela internet (comum falhar em
      // serviços como Railway/Render, causando fontes e imagens que não
      // carregam silenciosamente no PDF). Usa a porta real em que o
      // servidor está escutando (pode diferir de process.env.PORT se essa
      // porta estava ocupada e o servidor precisou usar outra).
      const actualPort = req.app.locals.actualPort || process.env.PORT || "3000";
      const baseUrl = `http://127.0.0.1:${actualPort}`;

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
