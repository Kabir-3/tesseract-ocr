const { PDFParse } = require("pdf-Parse");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { createWorker } = require("tesseract.js");

const app = express();
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
        const infoResult = await parser.getInfo({parsePageInfo: true});

        return res.json({
            meta:{
                filename: req.file.originalname,
                mimetype: req.file.mimetype,
                sizeBytes: req.file.size,
                pages: infoResult?.total || 0,
            },
            fullText: (textResult?.text || "").trim(),
            method: "pdf-text-extraction",
        });
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
