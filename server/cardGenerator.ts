import path from "path";
import fs from "fs";
import puppeteer, { Browser, Page } from "puppeteer-core";
import archiver from "archiver";
import xlsx from "xlsx";
import { EventEmitter } from "events";

const BASE_DIR = path.resolve();
const OUTPUT_DIR = path.join(BASE_DIR, "output");
const TMP_DIR = path.join(BASE_DIR, "tmp");
const TEMPLATES_DIR = path.join(BASE_DIR, "templates");
const LOGOS_DIR = path.join(BASE_DIR, "logos");
const SELOS_DIR = path.join(BASE_DIR, "selos");

export type GeneratedCard = {
  ordem: string;
  tipo: string;
  categoria: string;
  categoriaSlug: string;
  texto: string;
  valor: string;
  cupom: string;
  logoFile: string;
  hasLogo: boolean;
  pdfName: string;
  pngName: string;
  htmlName: string;
  pdfUrl: string;
  pngUrl: string;
  htmlUrl: string;
  html: string;
};

export type GenerateCardsResult = {
  zipPath: string;
  zipName: string;
  jobId: string;
  cards: GeneratedCard[];
  totalRows: number;
  processedRows: number;
};

const VALID_TYPES = ["promocao", "cupom", "cashback", "queda", "bc", "soma", "nada"];

type ProgressStage =
  | "iniciando"
  | "lendo_planilha"
  | "validando_planilha"
  | "preparando_card"
  | "carregando_template"
  | "processando_imagens"
  | "renderizando_html"
  | "aguardando_recursos"
  | "gerando_pdf"
  | "gerando_png"
  | "card_finalizado"
  | "compactando_zip"
  | "finalizado"
  | "erro";

export class CardGenerator extends EventEmitter {
  private browser: Browser | null = null;

  async initialize() {
    for (const dir of [OUTPUT_DIR, TMP_DIR]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    const executablePath =
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      process.env.CHROME_BIN ||
      process.env.CHROMIUM_PATH ||
      "/usr/bin/chromium";

    console.log(`[CardGenerator] Launching browser with: ${executablePath}`);

    this.browser = await puppeteer.launch({
      executablePath,
      headless: true,
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

    console.log("[CardGenerator] Browser launched successfully");
  }

  normalizeType(tipo: string): string {
    if (!tipo) return "";

    const normalized = String(tipo)
      .toLowerCase()
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    if (normalized.includes("promo")) return "promocao";
    if (normalized.includes("cupom")) return "cupom";
    if (normalized.includes("queda")) return "queda";
    if (normalized.includes("cashback")) return "cashback";
    if (normalized === "bc") return "bc";
    if (normalized.includes("soma")) return "soma";
    if (normalized.includes("nada")) return "nada";

    return "";
  }

  private sanitizeFileName(value: string): string {
    return (
      String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-")
        .toLowerCase()
        .trim() || "sem-nome"
    );
  }

  private getDateStamp(): string {
    const now = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })
    );

    const dd = String(now.getDate()).padStart(2, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const aa = String(now.getFullYear()).slice(-2);
    const hh = String(now.getHours()).padStart(2, "0");
    const min = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");

    return `${dd}_${mm}_${aa}-${hh}_${min}_${ss}`;
  }

  private getUniqueFilePath(filePath: string): string {
    if (!fs.existsSync(filePath)) return filePath;

    const ext = path.extname(filePath);
    const name = path.basename(filePath, ext);
    const dir = path.dirname(filePath);

    let counter = 2;
    let newPath = "";

    do {
      newPath = path.join(dir, `${name}_v${counter}${ext}`);
      counter++;
    } while (fs.existsSync(newPath));

    return newPath;
  }

  imageToBase64(imagePath: string): string {
    if (
      !imagePath ||
      !fs.existsSync(imagePath) ||
      fs.lstatSync(imagePath).isDirectory()
    ) {
      return "";
    }

    const ext = path.extname(imagePath).replace(".", "").toLowerCase();
    const buffer = fs.readFileSync(imagePath);

    let mimeType = `image/${ext}`;
    if (ext === "svg") mimeType = "image/svg+xml";
    if (ext === "jpg" || ext === "jfif" || ext === "jpeg") mimeType = "image/jpeg";
    if (ext === "avif") mimeType = "image/avif";

    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  }

  private findLogoFile(logoName: string): string {
    if (!fs.existsSync(LOGOS_DIR)) return "";
    if (!logoName || String(logoName).trim() === "") return "";

    const cleanName = String(logoName).trim();
    const extensions = [".png", ".jpg", ".jpeg", ".webp", ".svg", ".jfif", ".avif"];
    const filesInLogos = fs.readdirSync(LOGOS_DIR);

    if (fs.existsSync(path.join(LOGOS_DIR, cleanName))) return cleanName;

    const searchName = cleanName.toLowerCase();

    for (const ext of extensions) {
      const target = searchName.endsWith(ext) ? searchName : searchName + ext;
      const found = filesInLogos.find((f) => f.toLowerCase() === target);
      if (found) return found;
    }

    const validFiles = filesInLogos.filter((f) =>
      extensions.includes(path.extname(f).toLowerCase())
    );

    const prefixMatch = validFiles.find((f) =>
      path.parse(f).name.toLowerCase().startsWith(searchName)
    );

    return prefixMatch || "";
  }

  private validateRows(rows: any[]): void {
    if (!rows || rows.length === 0) {
      throw new Error("A planilha está vazia.");
    }

    const headers = Object.keys(rows[0] ?? {}).map((h) =>
      h.toLowerCase().trim()
    );

    const requiredHeaders = ["ordem", "tipo"];
    const missingHeaders = requiredHeaders.filter(
      (header) => !headers.includes(header)
    );

    if (missingHeaders.length) { 
      throw new Error(
        `Colunas obrigatórias ausentes: ${missingHeaders.join(", ")}.`
      );
    }

    const errors: string[] = [];
    const usedOrders = new Set<string>();

    rows.forEach((row, index) => { 
      const line = index + 2;

      const ordem = String(row.ordem ?? "").trim();
      const tipoOriginal = String(row.tipo ?? "").trim();
      const tipo = this.normalizeType(tipoOriginal);

      const valor = String(row.valor ?? "").trim();
      const cupom = String(row.cupom ?? "").trim();
      const logo = String(row.logo ?? "").trim();
      const complemento = String(row.complemento ?? "").trim();

      const selo = String(row.selo ?? "")
        .trim()
        .toLowerCase();

      if (!ordem) { 
        errors.push(`Linha ${line}: campo ORDEM vazio.`);
      } else {
        if (usedOrders.has(ordem)) {
          errors.push(`Linha ${line}: ordem duplicada (${ordem}).`);
        }

        if (isNaN(Number(ordem))) {
          errors.push(`Linha ${line}: ORDEM deve ser numérica.`);
        }

        usedOrders.add(ordem);
      }

      if (!tipoOriginal) {
        errors.push(`Linha ${line}: coluna TIPO vazia.`); 
        return;
      }

      if (!tipo || !VALID_TYPES.includes(tipo)) {
        errors.push(
          `Linha ${line}: tipo "${tipoOriginal}" não reconhecido.`
        );
        return;
      }

      if (
        selo &&
        !["nova", "novo", "renovada", "renovado"].includes(selo) 
      ) {
        errors.push(
          `Linha ${line}: selo inválido. Use nova, novo, renovada ou renovado.`
        );
      }

      if (tipo === "nada") { 
        return;
      }

      if (tipo === "soma") {
        if (!valor) { 
          errors.push(
            `Linha ${line}: template SOMA exige o campo VALOR.`
          );
        }

        if (!complemento) {
          errors.push(
            `Linha ${line}: template SOMA exige o campo COMPLEMENTO.`
          );
        }

        return;
      }

      if (!logo) { 
        errors.push(
          `Linha ${line}: campo LOGO não pode ficar vazio.`
        );
      }

      if (tipo === "cupom" && !cupom) {
        errors.push(
          `Linha ${line}: template CUPOM exige o campo CUPOM preenchido.`
        );
      }

      if (tipo === "promocao") {
        if (!valor) { 
          errors.push(
            `Linha ${line}: template PROMOCAO exige o campo VALOR.`
          );
        }

        return;
      }

      if (["queda", "bc", "cashback"].includes(tipo)) {
        if (!valor) { 
          errors.push(
            `Linha ${line}: template ${tipo.toUpperCase()} exige o campo VALOR.`
          );
        } else {
          const normalizedValue = valor
            .replace(/%/g, "")
            .replace(/\./g, ",")
            .trim();

          const numericValidation = normalizedValue.replace(/,/g, ".");

          if (isNaN(Number(numericValidation))) {
            errors.push(
              `Linha ${line}: template ${tipo.toUpperCase()} aceita apenas números no VALOR.`
            );
          }

          row.valor = normalizedValue;
        }
      }
    });

    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }
  }

  private injectFittingHelpers(html: string): string {
    const helper = `
<style id="fit-container-helpers">
  html, body {
    width:700px;
    min-width:700px;
    max-width:700px;
    height:1058px;
    min-height:1058px;
    max-height:1058px;
    margin:0;
    padding:0;
    overflow:hidden;
    background:transparent;
  }

  .card {
    background:#fff;
    overflow:hidden;
  }

  .logo,
  .selo,
  .valor-container,
  .cupom-codigo {
    overflow:hidden;
  }

  .logo img[src=""],
  .logo img:not([src]),
  .selo img[src=""],
  .selo img:not([src]) {
    display:none !important;
  }

  #valor-texto,
  .valor-texto,
  #cupom-text {
    text-rendering:geometricPrecision;
  }
</style>

<script>
(function(){
  function fitText(el, container, opts){
    try {
      if(!el || !container) return;

      var max = opts.max || 480;
      var min = opts.min || 10;
      var limit = opts.limit || 700;
      var count = 0;

      el.style.display = "block";
      el.style.maxWidth = "100%";
      el.style.textAlign = "center";
      el.style.whiteSpace = opts.nowrap ? "nowrap" : "normal";
      el.style.wordBreak = "keep-all";
      el.style.overflowWrap = "normal";
      el.style.lineHeight = opts.lineHeight || "0.92";

      for(var size = max; size >= min && count < limit; size--){
        el.style.fontSize = size + "px";

        if(
          el.scrollWidth <= container.clientWidth &&
          el.scrollHeight <= container.clientHeight
        ){
          break;
        }

        count++;
      }
    } catch(e) {
      console.error("[fitText] erro:", e);
    }
  }

  function run(){
    try {
      fitText(
        document.getElementById("valor-texto") || document.querySelector(".valor-texto"),
        document.getElementById("valor-container") || document.querySelector(".valor-container"),
        { max: 520, min: 22, nowrap: false, lineHeight: "0.9", limit: 600 }
      );

      fitText(
        document.getElementById("cupom-text"),
        document.querySelector(".cupom-codigo"),
        { max: 120, min: 18, nowrap: true, lineHeight: "1", limit: 160 }
      );
    } catch(e) {
      console.error("[__fitCards] erro:", e);
    }
  }

  window.__fitCards = run;

  if(document.fonts && document.fonts.ready) {
    document.fonts.ready.then(run).catch(function(){ run(); });
  } else {
    window.addEventListener("load", run);
  }
})();
</script>`;

    return html.includes("</body>")
      ? html.replace("</body>", `${helper}</body>`)
      : html + helper;
  }

  private replacePlaceholders(
    html: string,
    row: any,
    tipo: string,
    logoBase64: string,
    seloBase64: string
  ): string {
    let valorFinal = String(row.valor ?? "");

    if (tipo !== "promocao") {
      valorFinal = valorFinal.replace(/%/g, "").trim();
    }

    const segmentoRaw =
      row.segmento && String(row.segmento).trim() !== ""
        ? String(row.segmento).trim()
        : "";

    return html
      .replaceAll("{{TEXTO}}", String(row.texto ?? ""))
      .replaceAll("{{VALOR}}", valorFinal)
      .replaceAll("{{COMPLEMENTO}}", String(row.complemento ?? ""))
      .replaceAll("{{LEGAL}}", String(row.legal ?? ""))
      .replaceAll("{{SEGMENTO}}", segmentoRaw)
      .replaceAll("{{CUPOM}}", String(row.cupom ?? ""))
      .replaceAll("{{UF}}", row.uf ? `UF: ${row.uf}` : "")
      .replaceAll("{{URN}}", row.urn ? `URN: ${row.urn}` : "")
      .replaceAll("{{LOGO}}", logoBase64)
      .replaceAll("{{SELO}}", seloBase64);
  }

  private async waitForPageReady(page: Page) {
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
              setTimeout(resolve, 3000);
            });
          })
        );

        // @ts-ignore
        if (window.__fitCards) window.__fitCards();

        await new Promise((resolve) => setTimeout(resolve, 250));
      } catch (error) {
        console.error("[waitForPageReady] erro:", error);
      }
    });
  }

  private async ensureBrowserAlive() {
    if (!this.browser || !this.browser.connected) {
      this.browser = null;
      await this.initialize();
    }
  }


  private emitProgress(data: {
    processed: number;
    total: number;
    currentCard: string;
    stage: ProgressStage;
    percentage?: number;
    detail?: string;
    currentIndex?: number;
  }) {
    const safeTotal = data.total || 0;
    const percentage =
      typeof data.percentage === "number"
        ? data.percentage
        : safeTotal > 0
          ? Math.round((data.processed / safeTotal) * 100)
          : 0;

    this.emit("progress", {
      processed: data.processed,
      total: data.total,
      percentage,
      currentCard: data.currentCard,
      stage: data.stage,
      detail: data.detail || "",
      currentIndex: data.currentIndex,
      updatedAt: new Date().toISOString(),
    });
  }

  async generateCards(
    excelFilePath: string,
    originalFileName?: string
  ): Promise<GenerateCardsResult> {
    await this.ensureBrowserAlive();

    if (!this.browser) throw new Error("Browser not initialized");

    this.emitProgress({
      processed: 0,
      total: 0,
      percentage: 0,
      currentCard: "Iniciando geração dos cards...",
      stage: "iniciando",
      detail: "Preparando pastas e ambiente de geração.",
    });

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const jobDir = path.join(OUTPUT_DIR, jobId);

    fs.mkdirSync(jobDir, { recursive: true });

    this.emitProgress({
      processed: 0,
      total: 0,
      percentage: 2,
      currentCard: "Lendo planilha...",
      stage: "lendo_planilha",
      detail: "Abrindo o arquivo Excel enviado.",
    });

    const workbook = xlsx.readFile(excelFilePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    const rows: any[] = xlsx.utils.sheet_to_json(sheet, {
      defval: "",
      raw: false,
    });

    this.emitProgress({
      processed: 0,
      total: rows.length,
      percentage: 4,
      currentCard: "Validando dados da planilha...",
      stage: "validando_planilha",
      detail: "Conferindo colunas obrigatórias, tipos e valores.",
    });

    this.validateRows(rows);

    const total = rows.length;
    let processed = 0;
    const cards: GeneratedCard[] = [];

    const BATCH_SIZE = 1;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);

      for (const [batchIndex, row] of batch.entries()) {
        await this.ensureBrowserAlive();

        if (!this.browser) throw new Error("Browser not initialized");

        const index = i + batchIndex;
        const tipo = this.normalizeType(row.tipo);
        const templatePath = path.join(TEMPLATES_DIR, `${tipo}.html`);

        this.emitProgress({
          processed,
          total,
          currentIndex: index + 1,
          currentCard: `Card ${index + 1}/${total} - preparando dados`,
          stage: "preparando_card",
          detail: `Tipo: ${tipo || "não identificado"}`,
        });

        if (!fs.existsSync(templatePath)) {
          throw new Error(`Template não encontrado: templates/${tipo}.html`);
        }

        this.emitProgress({
          processed,
          total,
          currentIndex: index + 1,
          currentCard: `Card ${index + 1}/${total} - processando imagens`,
          stage: "processando_imagens",
          detail: "Localizando logo e selo.",
        });

        const logoFile = this.findLogoFile(row.logo);
        const logoBase64 = logoFile
          ? this.imageToBase64(path.join(LOGOS_DIR, logoFile))
          : "";
        const hasLogo = Boolean(logoBase64);

        const seloRaw = String(row.selo ?? "").trim().toLowerCase();
        const seloBase64 = seloRaw
          ? this.imageToBase64(
              path.join(
                SELOS_DIR,
                seloRaw === "nova" || seloRaw === "novo"
                  ? "acaonova.png"
                  : seloRaw === "renovada" || seloRaw === "renovado"
                    ? "acaorenovada.png"
                    : "blank.png"
              )
            )
          : "";

        let html = fs.readFileSync(templatePath, "utf8");

        html = this.replacePlaceholders(html, row, tipo, logoBase64, seloBase64);
        html = this.injectFittingHelpers(html);

        const ordemFinal =
          row.ordem && String(row.ordem).trim() !== ""
            ? String(row.ordem).trim()
            : String(index + 1);

        const categoriaRaw =
          row.categoria && String(row.categoria).trim() !== ""
            ? String(row.categoria).trim()
            : "sem-categoria";

        const categoriaSlug = this.sanitizeFileName(categoriaRaw);
        const safeOrdem = this.sanitizeFileName(ordemFinal);

        const pdfName = `${safeOrdem}_${tipo}_${categoriaSlug}.pdf`;
        const pngName = `${safeOrdem}_${tipo}_${categoriaSlug}.png`;
        const htmlName = `${safeOrdem}_${tipo}_${categoriaSlug}.html`;

        const pdfPath = path.join(jobDir, pdfName);
        const pngPath = path.join(jobDir, pngName);
        const htmlPath = path.join(jobDir, htmlName);
        const tmpHtmlPath = path.join(TMP_DIR, `${jobId}_card_${index + 1}.html`);

        fs.writeFileSync(tmpHtmlPath, html, "utf8");
        fs.writeFileSync(htmlPath, html, "utf8");

        let page: Page | null = null;

        try {
          page = await this.browser.newPage();
          await page.setViewport({
            width: 700,
            height: 1058,
            deviceScaleFactor: 1,
          });

          await page.setContent(html, {
            waitUntil: "load",
            timeout: 60000,
          });

          await this.waitForPageReady(page);

          await page.pdf({
            path: pdfPath,
            width: "700px",
            height: "1058px",
            printBackground: true,
            margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
          });

          await page.screenshot({
            path: pngPath,
            type: "png",
            fullPage: false,
          });
        } catch (pageErr) {
          throw pageErr;
        } finally {
          if (page) await page.close();
        }

        processed++;

        const card: GeneratedCard = {
          ordem: ordemFinal,
          tipo,
          categoria: categoriaRaw,
          categoriaSlug,
          texto: String(row.texto ?? ""),
          valor: String(row.valor ?? ""),
          cupom: String(row.cupom ?? ""),
          logoFile,
          hasLogo,
          pdfName,
          pngName,
          htmlName,
          pdfUrl: `/output/${jobId}/${pdfName}`,
          pngUrl: `/output/${jobId}/${pngName}`,
          htmlUrl: `/output/${jobId}/${htmlName}`,
          html,
        };

        cards.push(card);
      }
    }

    const baseName = originalFileName
      ? path.parse(originalFileName).name
      : path.parse(excelFilePath).name;

    const zipName = `${this.sanitizeFileName(baseName)}_${this.getDateStamp()}.zip`;
    const zipPath = this.getUniqueFilePath(path.join(jobDir, zipName));

    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.pipe(output);
    for (const card of cards) {
      archive.file(path.join(jobDir, card.pdfName), { name: card.pdfName });
    }
    await archive.finalize();

    return {
      zipPath,
      zipName: path.basename(zipPath),
      jobId,
      cards,
      totalRows: total,
      processedRows: processed,
    };
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
