import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Upload,
  CheckCircle2,
  Download,
  Hourglass,
  ImageIcon,
  Newspaper,
  FileDown,
  FileText,
  RefreshCcw,
  Pencil,
  AlertCircle,
} from "lucide-react";

type ProgressData = {
  total: number;
  processed: number;
  percentage: number;
  currentCard: string;
};

type GeneratedCard = {
  ordem: string;
  tipo: string;
  categoria: string;
  html: string;
  hasLogo: boolean;
};

type ProcessResult = {
  jobId?: string;
  zipPath: string;
  fileName?: string;
  cards: GeneratedCard[];
  totalRows: number;
  processedRows: number;
};

type JournalPagePayload = {
  type: "cover" | "category" | "ad";
  title: string;
  html: string;
};

type JournalCardPage = {
  category: string;
  cards: GeneratedCard[];
  pageIndexWithinCategory: number;
  isContinuation: boolean;
  // Adicionado para suportar múltiplas categorias na mesma página
  additionalCategories?: {
    category: string;
    cards: GeneratedCard[];
  }[];
};

type CategoryBarImages = Record<string, { left?: string; right?: string }>;

const FIRST_CATEGORY_PAGE_CARD_LIMIT = 6;
const CONTINUATION_CATEGORY_PAGE_CARD_LIMIT = 9;

function getReadableTextColor(backgroundColor: string) {
  const normalized = String(backgroundColor || "#ffffff").trim();
  const hexMatch = normalized.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);

  if (!hexMatch) return "#111111";

  const r = parseInt(hexMatch[1], 16);
  const g = parseInt(hexMatch[2], 16);
  const b = parseInt(hexMatch[3], 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

  return luminance > 0.58 ? "#111111" : "#ffffff";
}

/**
 * Nova lógica de construção de páginas:
 * Se a categoria for "NADA", ela não força quebra de página ao terminar.
 * A próxima categoria pode começar na mesma página se houver espaço.
 */
function buildJournalCardPages(groupedCards: [string, GeneratedCard[]][]): JournalCardPage[] {
  const pages: JournalCardPage[] = [];
  let currentGroupIdx = 0;

  while (currentGroupIdx < groupedCards.length) {
    const [category, cards] = groupedCards[currentGroupIdx];
    let remainingCards = [...cards];
    let pageIdxWithinCategory = 0;

    while (remainingCards.length > 0) {
      const isFirstPage = pageIdxWithinCategory === 0;
      const limit = isFirstPage ? FIRST_CATEGORY_PAGE_CARD_LIMIT : CONTINUATION_CATEGORY_PAGE_CARD_LIMIT;
      
      const pageCards = remainingCards.slice(0, limit);
      remainingCards = remainingCards.slice(limit);

      const newPage: JournalCardPage = {
        category,
        cards: pageCards,
        pageIndexWithinCategory,
        isContinuation: pageIdxWithinCategory > 0,
        additionalCategories: []
      };

      // LÓGICA ESPECIAL PARA "NADA":
      // Se for a categoria "NADA" e for a última página desta categoria, 
      // e ainda houver espaço na página, tentamos puxar a próxima categoria.
      if (category.toUpperCase() === "NADA" && remainingCards.length === 0 && pageCards.length < limit) {
        let spaceLeft = limit - pageCards.length;
        
        // Tenta preencher o espaço restante com as próximas categorias
        while (spaceLeft > 0 && currentGroupIdx + 1 < groupedCards.length) {
          currentGroupIdx++;
          const [nextCat, nextCards] = groupedCards[currentGroupIdx];
          
          const cardsToTake = nextCards.slice(0, spaceLeft);
          const leftover = nextCards.slice(spaceLeft);

          newPage.additionalCategories?.push({
            category: nextCat,
            cards: cardsToTake
          });

          spaceLeft -= cardsToTake.length;

          // Se a próxima categoria também coube inteira e não queremos que ela quebre página (caso fosse "NADA" também, por exemplo)
          // Mas pela regra, apenas o "NADA" permite essa junção. 
          // Se a categoria que puxamos sobrou cards, ela continuará na próxima página normalmente.
          if (leftover.length > 0) {
            // Recriamos a entrada da categoria atual com o que sobrou para o próximo loop externo processar
            groupedCards[currentGroupIdx] = [nextCat, leftover];
            currentGroupIdx--; // Decrementa para que o loop externo processe o que sobrou
            break;
          }
        }
      }

      pages.push(newPage);
      pageIdxWithinCategory++;
    }
    currentGroupIdx++;
  }

  return pages;
}

function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function groupByCategory(cards: GeneratedCard[]) {
  const groups: Record<string, GeneratedCard[]> = {};

  cards.forEach((card) => {
    const category = card.categoria?.trim() || "SEM CATEGORIA";
    if (!groups[category]) groups[category] = [];
    groups[category].push(card);
  });

  return Object.entries(groups);
}

function extractCardHtml(html: string) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const styles = Array.from(doc.querySelectorAll("style"))
    .map((style) => style.outerHTML)
    .join("\n");

  const body = doc.body?.innerHTML || html;

  return `
    ${styles}
    <style>
      :host {
        display:block;
        width:700px;
        height:1058px;
        overflow:hidden;
        background:#fff;
      }

      * {
        box-sizing:border-box;
      }

      .logo {
        cursor:pointer !important;
      }

      .logo:empty,
      .logo:not(:has(img)),
      .logo img[src=""] {
        background:#f1f1f1;
        border:2px dashed #d2d2d2;
        border-radius:14px;
      }
    </style>
    ${body}
  `;
}

function runCardFit(root: ShadowRoot) {
  const fitText = (
    el: HTMLElement | null,
    container: HTMLElement | null,
    options: { max: number; min: number; nowrap?: boolean; lineHeight?: string }
  ) => {
    if (!el || !container) return;

    el.style.display = "block";
    el.style.maxWidth = "100%";
    el.style.textAlign = "center";
    el.style.whiteSpace = options.nowrap ? "nowrap" : "normal";
    el.style.wordBreak = "keep-all";
    el.style.overflowWrap = "normal";
    el.style.lineHeight = options.lineHeight || "0.92";

    for (let size = options.max; size >= options.min; size--) {
      el.style.fontSize = `${size}px`;

      if (
        el.scrollWidth <= container.clientWidth &&
        el.scrollHeight <= container.clientHeight
      ) {
        break;
      }
    }
  };

  fitText(
    (root.getElementById("valor-texto") ||
      root.querySelector(".valor-texto")) as HTMLElement | null,
    (root.getElementById("valor-container") ||
      root.querySelector(".valor-container")) as HTMLElement | null,
    { max: 520, min: 22, nowrap: false, lineHeight: "0.9" }
  );

  fitText(
    root.getElementById("cupom-text") as HTMLElement | null,
    root.querySelector(".cupom-codigo") as HTMLElement | null,
    { max: 120, min: 18, nowrap: true, lineHeight: "1" }
  );

  const segmento = root.getElementById("segmento-bloco") as HTMLElement | null;
  if (segmento && segmento.textContent?.includes("{{SEGMENTO}}")) {
    segmento.style.display = "none";
  }

  const logo = root.querySelector(".logo") as HTMLElement | null;
  const logoImg = logo?.querySelector("img") as HTMLImageElement | null;
  if (logo && logoImg && !logoImg.getAttribute("src")) {
    logoImg.style.display = "none";
  }
}

function ShadowCard({
  html,
  cardKey,
}: {
  html: string;
  cardKey: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
    shadow.innerHTML = extractCardHtml(html);

    const setup = () => {
      runCardFit(shadow);

      const logo = shadow.querySelector(".logo") as HTMLElement | null;
      if (!logo) return;

      logo.onclick = (event) => {
        event.stopPropagation();

        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";

        input.onchange = async (changeEvent: Event) => {
          const target = changeEvent.target as HTMLInputElement | null;
          const selectedFile = target?.files?.[0];

          if (!selectedFile) return;

          if (!selectedFile.type.startsWith("image/")) {
            window.alert("Envie apenas arquivos de imagem.");
            return;
          }

          const dataUrl = await readImageAsDataUrl(selectedFile);

          let image = logo.querySelector("img") as HTMLImageElement | null;

          if (!image) {
            image = document.createElement("img");
            image.alt = "Logo";
            logo.appendChild(image);
          }

          image.src = dataUrl;
          image.style.display = "block";
        };

        input.click();
      };
    };

    requestAnimationFrame(setup);
  }, [html]);

  return (
    <div
      ref={hostRef}
      className="journal-card-shadow-host"
      data-card-key={cardKey}
    />
  );
}

function serializeElementForPdf(element: HTMLElement) {
  const clone = element.cloneNode(true) as HTMLElement;

  const originalHosts = Array.from(
    element.querySelectorAll(".journal-card-shadow-host")
  ) as HTMLDivElement[];

  const clonedHosts = Array.from(
    clone.querySelectorAll(".journal-card-shadow-host")
  ) as HTMLDivElement[];

  clonedHosts.forEach((clonedHost, index) => {
    const originalHost = originalHosts[index];
    const shadowHtml = originalHost?.shadowRoot?.innerHTML || "";

    clonedHost.innerHTML = `
      <template shadowrootmode="open">
        ${shadowHtml}
      </template>
    `;
  });

  const activateDeclarativeShadowDom = `
    <script>
      document.querySelectorAll("template[shadowrootmode]").forEach(function(template) {
        var mode = template.getAttribute("shadowrootmode") || "open";
        var parent = template.parentNode;
        if (!parent || parent.shadowRoot) return;

        try {
          if (typeof parent.setHTMLUnsafe === "function") {
            parent.setHTMLUnsafe(template.innerHTML);
          } else {
            var shadow = parent.attachShadow({ mode: mode });
            shadow.appendChild(template.content.cloneNode(true));
            template.remove();
          }
        } catch (e) {
          console.error("Erro ao ativar Shadow DOM:", e);
        }
      });
    </script>
  `;

  return `<style>${journalCss}</style>${clone.outerHTML}${activateDeclarativeShadowDom}`;
}

function buildJournalPagesForPdf(journalElement: HTMLDivElement): JournalPagePayload[] {
  const pages: JournalPagePayload[] = [];
  const coverPage = journalElement.querySelector('[data-journal-page="cover"]') as HTMLElement;
  if (coverPage) {
    pages.push({
      type: "cover",
      title: "Capa",
      html: serializeElementForPdf(coverPage),
    });
  }

  const categoryPages = Array.from(
    journalElement.querySelectorAll('[data-journal-page="category"]')
  ) as HTMLElement[];

  categoryPages.forEach((page) => {
    pages.push({
      type: "category",
      title: page.getAttribute("data-journal-title") || "Categoria",
      html: serializeElementForPdf(page),
    });
  });

  return pages;
}

const CATEGORY_BACKGROUNDS_STORAGE_KEY = "journal_category_backgrounds";
const CATEGORY_BAR_COLORS_STORAGE_KEY = "journal_category_bar_colors";
const CATEGORY_BAR_IMAGES_STORAGE_KEY = "journal_category_bar_images";

export default function CardProcessor() {
  const [, setLocation] = useLocation();
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [sessionId] = useState(() => Math.random().toString(36).slice(2, 12));
  const socketRef = useRef<Socket | null>(null);

  const [showJournal, setShowJournal] = useState(false);
  const [journalZoom, setJournalZoom] = useState(50);
  const [isGeneratingJournal, setIsGeneratingJournal] = useState(false);
  const journalRef = useRef<HTMLDivElement>(null);

  const [coverImage, setCoverImage] = useState("https://placehold.co/1080x1920/0b2341/ffffff?text=Capa+do+Jornal");
  const [headerImage, setHeaderImage] = useState("https://placehold.co/1080x260/0b2341/ffffff?text=Cabeçalho");
  const coverInputRef = useRef<HTMLInputElement>(null);
  const headerInputRef = useRef<HTMLInputElement>(null);

  const [categoryBackgrounds, setCategoryBackgrounds] = useState<Record<string, string>>(() => {
    const saved = window.localStorage.getItem(CATEGORY_BACKGROUNDS_STORAGE_KEY);
    return saved ? JSON.parse(saved) : {};
  });

  const [categoryBarColors, setCategoryBarColors] = useState<Record<string, string>>(() => {
    const saved = window.localStorage.getItem(CATEGORY_BAR_COLORS_STORAGE_KEY);
    return saved ? JSON.parse(saved) : {};
  });

  const [categoryBarImages, setCategoryBarImages] = useState<CategoryBarImages>(() => {
    const saved = window.localStorage.getItem(CATEGORY_BAR_IMAGES_STORAGE_KEY);
    return saved ? JSON.parse(saved) : {};
  });

  const generateCardsMutation = trpc.cards.generate.useMutation();
  const generateJournalMutation = trpc.cards.generateJournal.useMutation();

  const groupedCards = useMemo(() => {
    if (!result?.cards) return [];
    return groupByCategory(result.cards);
  }, [result]);

  const journalCardPages = useMemo(() => {
    return buildJournalCardPages(groupedCards);
  }, [groupedCards]);

  const getCategoryBackground = (category: string) => categoryBackgrounds[category] || "#ffffff";
  const getCategoryBarColor = (category: string) => categoryBarColors[category] || "#0f6bc8";
  const getCategoryBarImage = (category: string, side: "left" | "right") => categoryBarImages[category]?.[side];

  const updateCategoryBackground = (category: string, color: string) => {
    setCategoryBackgrounds((current) => ({ ...current, [category]: color }));
  };

  const updateCategoryBarColor = (category: string, color: string) => {
    setCategoryBarColors((current) => ({ ...current, [category]: color }));
  };

  const updateCategoryBarImage = async (category: string, side: "left" | "right", file?: File) => {
    if (!file) return;
    const dataUrl = await readImageAsDataUrl(file);
    setCategoryBarImages((current) => ({
      ...current,
      [category]: {
        ...(current[category] || {}),
        [side]: dataUrl,
      },
    }));
  };

  const chooseCategoryBarImage = (category: string, side: "left" | "right") => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";

    input.onchange = (event: Event) => {
      const target = event.target as HTMLInputElement | null;
      updateCategoryBarImage(category, side, target?.files?.[0]);
    };

    input.click();
  };

  const updateJournalZoom = (nextZoom: number) => {
    const safeZoom = Math.min(100, Math.max(15, Math.round(nextZoom || 50)));
    setJournalZoom(safeZoom);
  };

  const errorLines = useMemo(() => {
    if (!error) return [];
    const safeError = typeof error === "string" ? error : JSON.stringify(error, null, 2);
    return safeError.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  }, [error]);

  const isSpreadsheetValidationError = useMemo(() => {
    if (!error) return false;
    const normalizedError = error.toLowerCase();
    return (
      errorLines.length > 1 ||
      normalizedError.includes("linha ") ||
      normalizedError.includes("coluna obrigatória") ||
      normalizedError.includes("planilha") ||
      normalizedError.includes("ordem") ||
      normalizedError.includes("cupom")
    );
  }, [error, errorLines]);

  useEffect(() => {
    const socket = io({
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
    });

    socket.on("connect", () => socket.emit("join", sessionId));
    socket.on("progress", (data: ProgressData) => setProgress(data));
    socket.on("error", (message: string) => {
      setError(message);
      setIsProcessing(false);
    });

    socketRef.current = socket;
    return () => {
      socket.disconnect();
    };
  }, [sessionId]);

  useEffect(() => {
    window.localStorage.setItem(CATEGORY_BACKGROUNDS_STORAGE_KEY, JSON.stringify(categoryBackgrounds));
  }, [categoryBackgrounds]);

  useEffect(() => {
    window.localStorage.setItem(CATEGORY_BAR_COLORS_STORAGE_KEY, JSON.stringify(categoryBarColors));
  }, [categoryBarColors]);

  useEffect(() => {
    window.localStorage.setItem(CATEGORY_BAR_IMAGES_STORAGE_KEY, JSON.stringify(categoryBarImages));
  }, [categoryBarImages]);

  const handleFileSelect = (selectedFile: File | null | undefined) => {
    if (!selectedFile) return;
    if (!selectedFile.name.toLowerCase().endsWith(".xlsx")) {
      setError("Arquivo inválido: envie uma planilha no formato .xlsx.");
      return;
    }
    setFile(selectedFile);
    setError(null);
    setResult(null);
    setShowJournal(false);
  };

  const handleUpload = async () => {
    if (!file) return;
    setIsProcessing(true);
    setProgress({ total: 0, processed: 0, percentage: 0, currentCard: "Preparando upload..." });
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const uploadResponse = await fetch("/api/upload", { method: "POST", body: formData });
      const uploadJson = await uploadResponse.json();

      if (!uploadResponse.ok) throw new Error(uploadJson.error || "Erro ao enviar arquivo.");

      const data = await generateCardsMutation.mutateAsync({
        filePath: uploadJson.filePath,
        sessionId,
        originalFileName: uploadJson.fileName,
      });

      setResult(data as ProcessResult);
      setProgress({ total: data.totalRows, processed: data.processedRows, percentage: 100, currentCard: "Finalizado" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao processar a planilha.");
    } finally {
      setIsProcessing(false);
    }
  };

  const changeImage = async (kind: "cover" | "header", file?: File) => {
    if (!file) return;
    const dataUrl = await readImageAsDataUrl(file);
    if (kind === "cover") setCoverImage(dataUrl);
    else setHeaderImage(dataUrl);
  };

  const generateJournalPdf = async () => {
    if (!journalRef.current) return;
    setIsGeneratingJournal(true);
    try {
      const pages = buildJournalPagesForPdf(journalRef.current);
      const { downloadUrl } = await generateJournalMutation.mutateAsync({
        jobId: result?.jobId || "manual",
        pages,
      });
      window.open(downloadUrl, "_blank");
    } catch (err) {
      window.alert("Erro ao gerar o PDF do jornal.");
    } finally {
      setIsGeneratingJournal(false);
    }
  };

  const reset = () => {
    setFile(null);
    setResult(null);
    setProgress(null);
    setError(null);
    setShowJournal(false);
  };

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-12 font-sans text-slate-50 antialiased selection:bg-blue-500/30">
      <div className="mx-auto max-w-5xl">
        <header className="mb-12 text-center">
          <div className="mb-4 inline-flex items-center justify-center rounded-2xl bg-blue-600/10 p-3 text-blue-500 ring-1 ring-blue-500/20">
            <ImageIcon className="h-8 w-8" />
          </div>
          <h1 className="text-4xl font-black tracking-tight text-white sm:text-5xl">
            Gerador de <span className="text-blue-500">Cards</span>
          </h1>
          <p className="mt-4 text-lg font-medium text-slate-400">
            Transforme sua planilha Excel em cartões promocionais e jornais diagramados.
          </p>
        </header>

        <section className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/5 p-8 backdrop-blur-xl sm:p-12">
          <div className="absolute -left-24 -top-24 h-64 w-64 rounded-full bg-blue-600/10 blur-3xl" />
          <div className="absolute -right-24 -bottom-24 h-64 w-64 rounded-full bg-blue-600/10 blur-3xl" />

          <div className="relative mx-auto max-w-xl">
            {!result && !isProcessing && (
              <div className="space-y-8">
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleFileSelect(e.dataTransfer.files[0]);
                  }}
                  className={`group relative flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-12 transition-all hover:bg-white/5 ${
                    file ? "border-blue-500 bg-blue-500/5" : "border-white/20 hover:border-white/40"
                  }`}
                  onClick={() => document.getElementById("file-input")?.click()}
                >
                  <input
                    id="file-input"
                    type="file"
                    className="hidden"
                    accept=".xlsx"
                    onChange={(e) => handleFileSelect(e.target.files?.[0])}
                  />
                  <div className={`mb-4 rounded-full p-4 transition-transform group-hover:scale-110 ${
                    file ? "bg-blue-500 text-white" : "bg-white/10 text-white/60"
                  }`}>
                    <Upload className="h-8 w-8" />
                  </div>
                  <h3 className="text-xl font-bold text-white">
                    {file ? file.name : "Arraste sua planilha"}
                  </h3>
                  <p className="mt-2 text-sm font-medium text-slate-400">
                    Clique para selecionar ou arraste um arquivo .xlsx
                  </p>
                </div>

                <Button
                  disabled={!file}
                  onClick={handleUpload}
                  className="h-14 w-full rounded-2xl bg-blue-600 text-lg font-bold shadow-lg shadow-blue-600/20 transition-all hover:bg-blue-700 hover:shadow-blue-600/40 disabled:opacity-50"
                >
                  Processar Planilha
                </Button>
              </div>
            )}

            {isProcessing && progress && (
              <div className="space-y-8 py-4 text-center">
                <div className="relative mx-auto h-32 w-32">
                  <svg className="h-full w-full" viewBox="0 0 100 100">
                    <circle
                      className="text-white/10"
                      strokeWidth="8"
                      stroke="currentColor"
                      fill="transparent"
                      r="42"
                      cx="50"
                      cy="50"
                    />
                    <circle
                      className="text-blue-500 transition-all duration-500"
                      strokeWidth="8"
                      strokeDasharray={264}
                      strokeDashoffset={264 - (264 * progress.percentage) / 100}
                      strokeLinecap="round"
                      stroke="currentColor"
                      fill="transparent"
                      r="42"
                      cx="50"
                      cy="50"
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-2xl font-black text-white">{progress.percentage}%</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-bold text-white">{progress.currentCard}</h3>
                  <p className="text-sm font-medium text-slate-400">
                    Processando {progress.processed} de {progress.total} cards
                  </p>
                </div>
                <div className="flex items-center justify-center space-x-2 text-blue-400">
                  <Hourglass className="h-4 w-4 animate-spin" />
                  <span className="text-xs font-bold uppercase tracking-widest">Aguarde um momento</span>
                </div>
              </div>
            )}

            {error && (
              <div className="space-y-6">
                <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-6 text-center">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/20 text-red-500">
                    <AlertCircle className="h-6 w-6" />
                  </div>
                  <h3 className="mb-2 text-lg font-bold text-white">Ocorreu um erro</h3>
                  
                  {isSpreadsheetValidationError ? (
                    <div className="mt-4 max-h-60 overflow-y-auto rounded-xl bg-black/40 p-4 text-left">
                      <p className="mb-3 text-sm font-bold text-red-400">Erros encontrados na planilha:</p>
                      <ul className="space-y-2">
                        {errorLines.map((line, i) => (
                          <li key={i} className="flex items-start space-x-2 text-xs leading-relaxed text-slate-300">
                            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500/50" />
                            <span>{line}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="text-sm font-medium text-slate-300">{error}</p>
                  )}
                </div>
                <Button variant="ghost" onClick={reset} className="w-full text-slate-400 hover:text-white">
                  Tentar novamente
                </Button>
              </div>
            )}

            {result && !isProcessing && (
              <div className="space-y-6 py-4">
                <div className="flex flex-col items-center justify-center space-y-4">
                  <div className="rounded-full bg-green-500/20 p-4 text-green-500">
                    <CheckCircle2 className="h-12 w-12" />
                  </div>
                  <div className="text-center">
                    <h3 className="text-2xl font-bold text-white">Processamento Concluído!</h3>
                    <p className="mt-1 text-slate-400">{result.totalRows} cards gerados com sucesso.</p>
                  </div>
                </div>

                <Button
                  asChild
                  className="h-16 w-full rounded-2xl bg-green-600 text-lg font-bold shadow-lg shadow-green-600/20 transition-all hover:bg-green-700 hover:shadow-green-600/40"
                >
                  <a href={`/api/download/${result.jobId}/${result.zipName}`} download>
                    <Download className="mr-2 h-6 w-6" />
                    Baixar Cards (ZIP)
                  </a>
                </Button>

                <Button
                  onClick={() => setShowJournal(true)}
                  className="h-14 w-full rounded-2xl bg-blue-600 text-lg font-bold shadow-lg shadow-blue-600/20 transition-all hover:bg-blue-700 hover:shadow-blue-600/40"
                >
                  <Newspaper className="mr-2 h-6 w-6" />
                  Diagramar Jornal
                </Button>

                <Button variant="ghost" onClick={reset} className="w-full text-slate-400 hover:text-white">
                  <RefreshCcw className="mr-2 h-4 w-4" />
                  Novo processamento
                </Button>
              </div>
            )}
          </div>
        </section>

        {showJournal && result && (
          <section className="mt-12 space-y-8 animate-in fade-in slide-in-from-bottom-8 duration-700">
            <div className="flex flex-col gap-8 lg:flex-row">
              {/* Controles do Editor */}
              <aside className="w-full shrink-0 lg:w-80">
                <div className="sticky top-8 space-y-6 rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl">
                  <div className="space-y-2">
                    <h3 className="text-lg font-bold text-white">Configurações</h3>
                    <p className="text-xs font-medium text-slate-400 leading-relaxed">
                      Personalize as cores e imagens de cada categoria. Clique nas imagens no jornal para alterá-las.
                    </p>
                  </div>

                  <div className="space-y-4">
                    {groupedCards.map(([category]) => (
                      <div key={category} className="space-y-3 rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
                        <h4 className="text-xs font-black uppercase tracking-wider text-blue-400">{category}</h4>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <span className="text-[10px] font-bold uppercase text-slate-500">Fundo</span>
                            <div className="relative flex h-10 w-full items-center overflow-hidden rounded-xl bg-white/10">
                              <input
                                type="color"
                                value={getCategoryBackground(category)}
                                onChange={(e) => updateCategoryBackground(category, e.target.value)}
                                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                              />
                              <div className="ml-3 h-4 w-4 rounded-full border border-white/20" style={{ background: getCategoryBackground(category) }} />
                              <span className="ml-2 text-[10px] font-mono text-white/60">{getCategoryBackground(category).toUpperCase()}</span>
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <span className="text-[10px] font-bold uppercase text-slate-500">Tarja</span>
                            <div className="relative flex h-10 w-full items-center overflow-hidden rounded-xl bg-white/10">
                              <input
                                type="color"
                                value={getCategoryBarColor(category)}
                                onChange={(e) => updateCategoryBarColor(category, e.target.value)}
                                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                              />
                              <div className="ml-3 h-4 w-4 rounded-full border border-white/20" style={{ background: getCategoryBarColor(category) }} />
                              <span className="ml-2 text-[10px] font-mono text-white/60">{getCategoryBarColor(category).toUpperCase()}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-4 pt-4">
                    <div className="flex items-center justify-between rounded-2xl bg-white/5 p-2 ring-1 ring-white/10">
                      <button onClick={() => updateJournalZoom(journalZoom - 5)} className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 text-white transition-colors hover:bg-blue-600">
                        <span className="text-xl font-bold">−</span>
                      </button>
                      <div className="flex items-center space-x-1 px-4">
                        <span className="text-sm font-black text-white">{journalZoom}%</span>
                      </div>
                      <button onClick={() => updateJournalZoom(journalZoom + 5)} className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 text-white transition-colors hover:bg-blue-600">
                        <span className="text-xl font-bold">+</span>
                      </button>
                    </div>

                    <Button
                      disabled={isGeneratingJournal}
                      onClick={generateJournalPdf}
                      className="h-14 w-full rounded-2xl bg-blue-600 font-black shadow-lg shadow-blue-600/20 transition-all hover:bg-blue-700"
                    >
                      <FileDown className="mr-2 h-5 w-5" />
                      {isGeneratingJournal ? "Gerando..." : "Exportar PDF"}
                    </Button>
                  </div>
                </div>
              </aside>

              {/* Visualização do Jornal */}
              <div className="flex-1 overflow-hidden">
                <div className="journal-preview-container overflow-auto rounded-3xl border border-white/10 bg-black/20 p-8 shadow-inner">
                  <div
                    className="journal-preview-scaler origin-top"
                    style={{
                      width: `${1080 * (journalZoom / 100)}px`,
                      transform: `scale(${journalZoom / 100})`,
                      margin: "0 auto"
                    }}
                  >
                    <div ref={journalRef} className="journal-root">
                      {/* Capa */}
                      <div className="journal-page-label">Página 1 — Capa</div>
                      <div
                        className="journal-page journal-cover-page group"
                        data-journal-page="cover"
                        data-journal-title="Capa"
                        onClick={() => coverInputRef.current?.click()}
                      >
                        <img src={coverImage} alt="Capa" />
                        <div className="journal-placeholder opacity-0 transition-opacity group-hover:opacity-100">
                          <Pencil className="mr-4 h-12 w-12" />
                          Alterar Capa
                        </div>
                        <input type="file" ref={coverInputRef} className="hidden" accept="image/*" onChange={(e) => changeImage("cover", e.target.files?.[0])} />
                      </div>

                      {/* Páginas de Categorias */}
                      {journalCardPages.map((journalPage, pageIndex) => {
                        const categoryBackground = getCategoryBackground(journalPage.category);
                        const categoryBarColor = getCategoryBarColor(journalPage.category);
                        const categoryBarTextColor = getReadableTextColor(categoryBarColor);
                        const categoryBarLeftImage = getCategoryBarImage(journalPage.category, "left");
                        const categoryBarRightImage = getCategoryBarImage(journalPage.category, "right");
                        
                        const isNada = journalPage.category.toLowerCase() === "nada";

                        return (
                          <div key={`${journalPage.category}-${pageIndex}`}>
                            <div className="journal-page-label">
                              Página {pageIndex + 2} — {journalPage.category}
                              {journalPage.isContinuation ? " (continuação)" : ""}
                            </div>

                            <section
                              className={`journal-category-page ${journalPage.isContinuation ? "is-continuation" : ""}`}
                              data-journal-page="category"
                              data-journal-title={journalPage.isContinuation ? `${journalPage.category} - continuação` : journalPage.category}
                              style={{ background: categoryBackground }}
                            >
                              {/* Cabeçalho da Página (Banner Azul) - Oculto se for continuação */}
                              {!journalPage.isContinuation && (
                                <div className="journal-header group" onClick={() => headerInputRef.current?.click()}>
                                  <img src={headerImage} alt="Cabeçalho" />
                                  <span className="opacity-0 transition-opacity group-hover:opacity-100">Alterar Cabeçalho</span>
                                  <input type="file" ref={headerInputRef} className="hidden" accept="image/*" onChange={(e) => changeImage("header", e.target.files?.[0])} />
                                </div>
                              )}

                              {/* Primeira Categoria da Página */}
                              {!isNada && (
                                <div className="journal-category-bar" style={{ background: categoryBarColor, color: categoryBarTextColor }}>
                                  <button onClick={(e) => { e.stopPropagation(); chooseCategoryBarImage(journalPage.category, "left"); }} className="journal-category-bar-image-slot">
                                    {categoryBarLeftImage ? <img src={categoryBarLeftImage} alt="L" /> : <div className="h-full w-full bg-white/10" />}
                                  </button>
                                  <span className="journal-category-bar-title">{journalPage.category}</span>
                                  <button onClick={(e) => { e.stopPropagation(); chooseCategoryBarImage(journalPage.category, "right"); }} className="journal-category-bar-image-slot">
                                    {categoryBarRightImage ? <img src={categoryBarRightImage} alt="R" /> : <div className="h-full w-full bg-white/10" />}
                                  </button>
                                </div>
                              )}

                              <div className={`journal-grid ${isNada && !journalPage.isContinuation ? "pt-12" : ""}`}>
                                {journalPage.cards.map((card, idx) => (
                                  <div className="journal-card-wrap" key={`card-${idx}`}>
                                    <ShadowCard html={card.html} cardKey={`card-${pageIndex}-${idx}`} />
                                  </div>
                                ))}
                              </div>

                              {/* Categorias Adicionais na mesma página (Caso do NADA) */}
                              {journalPage.additionalCategories?.map((extra, extraIdx) => {
                                const extraBarColor = getCategoryBarColor(extra.category);
                                const extraBarTextColor = getReadableTextColor(extraBarColor);
                                const extraLeftImg = getCategoryBarImage(extra.category, "left");
                                const extraRightImg = getCategoryBarImage(extra.category, "right");

                                return (
                                  <div key={`extra-${extraIdx}`}>
                                    <div className="journal-category-bar" style={{ background: extraBarColor, color: extraBarTextColor }}>
                                      <button onClick={(e) => { e.stopPropagation(); chooseCategoryBarImage(extra.category, "left"); }} className="journal-category-bar-image-slot">
                                        {extraLeftImg ? <img src={extraLeftImg} alt="L" /> : <div className="h-full w-full bg-white/10" />}
                                      </button>
                                      <span className="journal-category-bar-title">{extra.category}</span>
                                      <button onClick={(e) => { e.stopPropagation(); chooseCategoryBarImage(extra.category, "right"); }} className="journal-category-bar-image-slot">
                                        {extraRightImg ? <img src={extraRightImg} alt="R" /> : <div className="h-full w-full bg-white/10" />}
                                      </button>
                                    </div>
                                    <div className="journal-grid">
                                      {extra.cards.map((card, idx) => (
                                        <div className="journal-card-wrap" key={`extra-card-${idx}`}>
                                          <ShadowCard html={card.html} cardKey={`extra-${extraIdx}-${idx}`} />
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })}

                              <div className="journal-footer-text" style={{ color: getReadableTextColor(categoryBackground), borderTopColor: getReadableTextColor(categoryBackground) === "#ffffff" ? "rgba(255,255,255,.2)" : "rgba(0,0,0,.1)" }}>
                                Ofertas válidas enquanto durarem os estoques. Consulte condições nos canais oficiais.
                              </div>
                            </section>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

const journalCss = `
  .journal-root {
    width: 1080px;
    background: #fff;
    color: #111;
    font-family: sans-serif;
  }
  .journal-page-label {
    height: 46px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #fff;
    border: 1px solid #ddd;
    font-weight: 900;
    text-transform: uppercase;
  }
  .journal-page {
    position: relative;
    width: 1080px;
    height: 1920px;
    overflow: hidden;
    margin-bottom: 40px;
  }
  .journal-cover-page img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .journal-placeholder {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.4);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 32px;
    font-weight: 900;
  }
  .journal-category-page {
    width: 1080px;
    min-height: 1920px;
    padding-bottom: 60px;
    margin-bottom: 40px;
    box-shadow: 0 20px 50px rgba(0,0,0,0.1);
  }
  .journal-header {
    height: 260px;
    background: #0b2341;
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-size: 32px;
    font-weight: 900;
  }
  .journal-header img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .journal-category-bar {
    width: 90%;
    margin: 40px auto 20px auto;
    height: 110px;
    border-radius: 55px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 30px;
    font-size: 32px;
    font-weight: 900;
    text-transform: uppercase;
  }
  .journal-category-bar-image-slot {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    overflow: hidden;
    background: none;
    border: none;
    padding: 0;
  }
  .journal-category-bar-image-slot img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .journal-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 25px;
    padding: 20px 50px;
  }
  .journal-card-wrap {
    height: 476px;
    background: #fff;
    border-radius: 20px;
    overflow: hidden;
    box-shadow: 0 10px 20px rgba(0,0,0,0.1);
  }
  .journal-card-shadow-host {
    width: 700px;
    height: 1058px;
    transform: scale(0.45);
    transform-origin: top left;
  }
  .journal-footer-text {
    margin: 40px 50px 0 50px;
    padding-top: 20px;
    border-top: 2px solid #ddd;
    text-align: center;
    font-size: 16px;
    font-weight: 600;
  }
`;
