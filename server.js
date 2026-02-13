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

// store uploads in memory (good for small POC files)
const upload = multer({ storage: multer.memoryStorage() });

app.get("/", (req, res) => {
  res.send("Tesseract running");
});

app.post("/ocr", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Use form-data key: file" });
    }

    const worker = await createWorker("eng");

    const result = await worker.recognize(req.file.buffer);
    const data = result.data;

    // Transform into a clean JSON shape
    const response = {
      meta: {
        filename: req.file.originalname,
        mimetype: req.file.mimetype,
        sizeBytes: req.file.size,
      },
      fullText: data.text?.trim() || "",
      confidence: data.confidence, // overall confidence
      words: (data.words || []).map(w => ({
        text: w.text,
        confidence: w.confidence,
        bbox: w.bbox, // { x0, y0, x1, y1 }
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
