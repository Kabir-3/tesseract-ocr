const { PDFParse } = require("pdf-parse");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { createWorker } = require("tesseract.js");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const app = express();

async function pdfToPngPaths(pdfBuffer) {

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-pdf"));
  const pdfPath = path.join(tmpDir, "input.pdf");
  const outPrefix = path.join(tmpDir,"page");

  await fs.writeFile(pdfPath, pdfBuffer);

  await execFileAsync("pdftoppm", ["-png","-r","200",pdfPath,outPrefix]);

  const files = await fs.readdir(tmpDir);

  const pngs = files
    .filter(f => f.startsWith("page-") && f.endsWith(".png"))
    .sort((a,b) => {
      const na = parseInt(a.match(/page-(\d+)\.png/)?.[1] || "0",10);
      const nb = parseInt(b.match(/page-(\d+)\.png/)?.[1] || "0", 10);
      return na-nb
    })  
    .map(f => path.join(tmpDir, f));

  return { tmpDir,pdfPath, pngs};

}

async function safeCleanupTmpDir(tmpDir) {
  if(!tmpDir) return;
  try {
    await fs.rm(tmpDir, {recursive: true, force: true});
  } catch {

  }
  
}


app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

app.get("/", (req, res) => {
  res.send("Tesseract running");
});

app.post("/ocr", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Use form-data key: file" });
    }

    if (req.file.mimetype === "application/pdf"){
        const parser = new PDFParse(new Uint8Array(req.file.buffer));
        const textResult = await parser.getText();
        const extractedText = (textResult?.text || "").trim();

        if (extractedText.length > 50) {
          const infoResult = await parser.getInfo({parsePageInfo: true});

          return res.json({
            meta: {
              filename: req.file.originalname,
              mimetype: req.file.mimetype,
              sizeBytes: req.file.size,
              pages: infoResult?.total || 0,
            },
            fullText: extractedText,
            method: "pdf-text-extraction"
          });
        }
 
        let tmpDir;
        try {
          const conv = await pdfToPngPaths(req.file.buffer);
          tmpDir = conv.tmpDir;
          const worker = await createWorker("eng");

          const pages = [];
          let merged = "";
          for(let i = 0; i < conv.pngs.length; i++) {
            const pngPath = conv.pngs[i];

            const ocrRes = await worker.recognize(pngPath);
            const pageText = (ocrRes.data.text || "").trim();

            pages.push({
              page: i + 1,
              confidence: ocrRes.data.confidence,
              fullText: pageText,
            });
            merged += pageText + "\n";
          }

          await worker.terminate();

          return res.json({
            meta: {
              filename: req.file.originalname,
              mimetype: req.file.mimetype,
              sizeBytes: req.file.size,
              pages: pages.length,
            },
            fullText: merged.trim(),
            pages,
            method: "pdf-ocr-fallback",
          });

        } finally {
          await safeCleanupTmpDir(tmpDir);
        }

    }

 

    const worker = await createWorker("eng");

    const result = await worker.recognize(req.file.buffer);
    const data = result.data;

    const response = {
      meta: {
        filename: req.file.originalname,
        mimetype: req.file.mimetype,
        sizeBytes: req.file.size,
      },
      fullText: data.text?.trim() || "",
      confidence: data.confidence, 
      words: (data.words || []).map(w => ({
        text: w.text,
        confidence: w.confidence,
        bbox: w.bbox, 
      }))
    };

    await worker.terminate();
    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "OCR failed", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
