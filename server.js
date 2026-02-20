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
const fsSync = require("fs");
const { PDFDocument } = require("pdf-lib");

const execFileAsync = promisify(execFile);

const livitMap = {
  "person.firstName": "Vorname",
  "person.lastName": "Nachname",
  "person.email": "EMail",
  "person.phone": "Telefon",
  "address.street": "Strasse",
  "address.houseNumber": "Hausnummer",
  "address.postalCode": "PLZ",
  "address.city": "Wohnort",
  "address.country": "Land"
};

const wincasaMap = {
  // Property / listing
  "property.address": "Adresse",
  "property.city": "Lieu 1",
  "property.rooms": "Nombre",
  "property.netRentCHF": "Loyer",
  "property.floor": "Etage",
  "property.extraCostsCHF": "Frais",
  "property.moveInDate": "Début du bail",
  "property.depositCHF": "Dépot",
  "property.grossRentCHF": "Loyer brut",

  // Applicant 1
  "applicants[0].lastName": "Nom",
  "applicants[0].firstName": "Prénom",
  "applicants[0].street": "Rue",
  "applicants[0].postalCode": "NPA",
  "applicants[0].phone": "Téléphone",
  "applicants[0].mobile": "Portable",
  "applicants[0].email": "E-mail",
  "applicants[0].dob": "Date de naissance",
  "applicants[0].maritalStatus": "Etat civil",
  "applicants[0].country": "Pays",
  "applicants[0].occupation": "Profession",
  "applicants[0].employer": "Employeur",

  // Applicant 2
  "applicants[1].lastName": "Nom2",
  "applicants[1].firstName": "Prénom2",
  "applicants[1].street": "Rue2",
  "applicants[1].postalCode": "NPA2",
  "applicants[1].phone": "Téléphone2",
  "applicants[1].mobile": "Portable2",
  "applicants[1].email": "E-mail2",
  "applicants[1].dob": "Date de naissance2",
  "applicants[1].country": "Pays2",
  "applicants[1].occupation": "Profession2",
  "applicants[1].employer": "Employeur2"
};

function setOneOfCheckboxes(form, fieldNames, chosenName) {
  // Uncheck all, then check chosen if present.
  for (const n of fieldNames) setCheckboxSafe(form, n, false);
  if (chosenName) setCheckboxSafe(form, chosenName, true);
}

function normalizeGender(g) {
  if (!g) return "";
  const s = String(g).toLowerCase();
  if (s.startsWith("m")) return "male";
  if (s.startsWith("f")) return "female";
  return "";
}

function normalizePermit(p) {
  if (!p) return "";
  const s = String(p).trim().toUpperCase();
  if (s === "B") return "B";
  if (s === "C") return "C";
  return "Autres";
}

function wincasaIncomeRangeName(income, suffix = "") {
  const n = Number(income);
  if (!Number.isFinite(n)) return "";

  // Field names must match the PDF exactly (note double spaces in the template names).
  if (n < 30000) return `0  30000${suffix}`;
  if (n < 40000) return `30000  40000${suffix}`;
  if (n < 50000) return `40000  50000${suffix}`;
  if (n < 60000) return `50000  60000${suffix}`;
  if (n < 70000) return `60000  70000${suffix}`;
  if (n < 80000) return `70000  80000${suffix}`;
  if (n < 100000) return `80000  100000${suffix}`;
  return `plus de 100000${suffix}`;
}

const app = express();

function getByPath(obj, dottedPath) {
  if (!dottedPath) return undefined;
  const parts = dottedPath.split(".");
  let cur = obj;

  for (const part of parts) {
    if (cur == null) return undefined;

    // Support array indexing like applicants[0]
    const m = part.match(/^(.+?)\[(\d+)\]$/);
    if (m) {
      const prop = m[1];
      const idx = Number(m[2]);
      cur = cur[prop];
      if (!Array.isArray(cur)) return undefined;
      cur = cur[idx];
      continue;
    }

    cur = cur[part];
  }

  return cur;
}

function setTextFieldSafe(form, fieldName, value) {
  try {
    form.getTextField(fieldName).setText(value == null ? "" : String(value));
    return true;
  } catch (e) {
    console.warn(`[fill] Missing/invalid text field: ${fieldName}`);
    return false;
  }
}

function setCheckboxSafe(form, fieldName, checked) {
  try {
    const cb = form.getCheckBox(fieldName);
    checked ? cb.check() : cb.uncheck();
    return true;
  } catch (e) {
    console.warn(`[fill] Missing/invalid checkbox field: ${fieldName}`);
    return false;
  }
}

function isoToParts(iso) {
  // Accepts YYYY-MM-DD and returns { day, month, year } as strings.
  if (!iso || typeof iso !== "string") return { day: "", month: "", year: "" };
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { day: "", month: "", year: "" };
  return { year: m[1], month: m[2], day: m[3] };
}

async function pdfToPngPaths(pdfBuffer) {

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-pdf-"));
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
  res.send("running");
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

app.post("/fill/livit", async (req, res) => {
  try {
    const body = req.body || {};
    // Support either direct payload `{ person: {...} }` OR wrapped payload `{ data: { person: {...} } }`
    const data = body.data ?? body;

    // Debug: confirm we actually received JSON
    console.log("[fill] content-type:", req.headers["content-type"]);
    console.log("[fill] body keys:", Object.keys(body));
    console.log("[fill] data keys:", Object.keys(data));

    if (!data || Object.keys(data).length === 0) {
      return res.status(400).json({
        error: "Empty JSON body",
        hint: "In Postman use Body -> raw -> JSON and ensure header Content-Type: application/json. If you are sending {data:{...}}, keep that wrapper." 
      });
    }

    // Load the template PDF from disk
    const templateBytes = fsSync.readFileSync(
      path.join(__dirname, "templates", "livit-template.pdf")
    );

    const pdfDoc = await PDFDocument.load(templateBytes);
    const form = pdfDoc.getForm();

    // 1) Fill text fields via mapping.
    // Supports either nested JSON (person.firstName) OR flat JSON (firstName).
    for (const [jsonPath, pdfFieldName] of Object.entries(livitMap)) {
      const nestedVal = getByPath(data, jsonPath);
      const flatKey = jsonPath.split(".").slice(-1)[0];
      const flatVal = data[flatKey];
      const value = nestedVal ?? flatVal ?? "";
      setTextFieldSafe(form, pdfFieldName, value);
    }

    // 2) Date of birth handling.
    // Accepts either explicit parts: dobDay/dobMonth/dobYear (flat) OR person.dob / dob as YYYY-MM-DD.
    const dobDay = data.dobDay ?? getByPath(data, "person.dobDay") ?? "";
    const dobMonth = data.dobMonth ?? getByPath(data, "person.dobMonth") ?? "";
    const dobYear = data.dobYear ?? getByPath(data, "person.dobYear") ?? "";

    if (dobDay || dobMonth || dobYear) {
      setTextFieldSafe(form, "Geburtstag_Tag", dobDay);
      setTextFieldSafe(form, "Geburtstag_Monat", dobMonth);
      setTextFieldSafe(form, "Geburtstag_Jahr", dobYear);
    } else {
      const dobIso = getByPath(data, "person.dob") ?? data.dob;
      const parts = isoToParts(dobIso);
      setTextFieldSafe(form, "Geburtstag_Tag", parts.day);
      setTextFieldSafe(form, "Geburtstag_Monat", parts.month);
      setTextFieldSafe(form, "Geburtstag_Jahr", parts.year);
    }

    // 3) Property fields (kept explicit because the PDF field names differ from obvious JSON keys)
    setTextFieldSafe(form, "Liegenschaft_Adresse", data.propertyAddress ?? getByPath(data, "property.address") ?? "");
    setTextFieldSafe(form, "Ort", data.propertyCity ?? getByPath(data, "property.city") ?? "");
    setTextFieldSafe(form, "Bezugstermin", data.moveInDate ?? getByPath(data, "property.moveInDate") ?? "");
    setTextFieldSafe(form, "Bruttomietzins", data.grossRentCHF ?? getByPath(data, "property.grossRentCHF") ?? "");
    setTextFieldSafe(form, "Anz_Zimmer", data.rooms ?? getByPath(data, "property.rooms") ?? "");

    // 4) Work/Income
    setTextFieldSafe(form, "Beruf", data.occupation ?? getByPath(data, "employment.occupation") ?? "");
    setTextFieldSafe(form, "Jahreseinkommen", data.annualIncomeCHF ?? getByPath(data, "employment.annualIncomeCHF") ?? "");

    // 5) Checkbox example: recommended by Livit
    const recommended =
      !!(data.recommendedByLivit ?? getByPath(data, "livit.recommended") ?? getByPath(data, "recommendedByLivit"));
    setCheckboxSafe(form, "KK_Empfohlen_Livit 2", recommended);

    // Lock values so they render reliably everywhere
    form.flatten();

    const outBytes = await pdfDoc.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="livit-filled.pdf"');
    return res.send(Buffer.from(outBytes));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "PDF fill failed", details: err.message });
  }
});

app.post("/fill/wincasa", async (req, res) => {
  try {
    const body = req.body || {};
    const data = body.data ?? body;
    const debug = body.debug ?? {};
    const debugCheck = Array.isArray(debug.check) ? debug.check : [];
    const debugUncheck = Array.isArray(debug.uncheck) ? debug.uncheck : [];

    // Load the template PDF from disk
    const templateBytes = fsSync.readFileSync(
      path.join(__dirname, "templates", "wincasa-template.pdf")
    );

    const pdfDoc = await PDFDocument.load(templateBytes);
    const form = pdfDoc.getForm();

    // 1) Text fields via mapping
    for (const [jsonPath, pdfFieldName] of Object.entries(wincasaMap)) {
      const value = getByPath(data, jsonPath);
      setTextFieldSafe(form, pdfFieldName, value ?? "");
    }

    // 2) Gender checkboxes (Applicant 1 + 2)
    const g1 = normalizeGender(getByPath(data, "applicants[0].gender"));
    setCheckboxSafe(form, "féminin", g1 === "female");
    setCheckboxSafe(form, "masculin", g1 === "male");

    const g2 = normalizeGender(getByPath(data, "applicants[1].gender"));
    setCheckboxSafe(form, "féminin_2", g2 === "female");
    setCheckboxSafe(form, "masculin_2", g2 === "male");

    // 3) Permit checkboxes (B/C/Autres + _2)
    const p1 = normalizePermit(getByPath(data, "applicants[0].permitType"));
    setOneOfCheckboxes(form, ["B", "C", "Autres"], p1);

    const p2 = normalizePermit(getByPath(data, "applicants[1].permitType"));
    setOneOfCheckboxes(form, ["B_2", "C_2", "Autres_2"], p2 ? `${p2}_2` : "");

    // 4) Income range checkboxes (Applicant 1 + 2)
    const income1 = getByPath(data, "applicants[0].annualIncomeCHF");
    const income2 = getByPath(data, "applicants[1].annualIncomeCHF");

    const ranges1 = [
      "0  30000",
      "30000  40000",
      "40000  50000",
      "50000  60000",
      "60000  70000",
      "70000  80000",
      "80000  100000",
      "plus de 100000"
    ];
    const ranges2 = ranges1.map(r => `${r}_2`);

    setOneOfCheckboxes(form, ranges1, wincasaIncomeRangeName(income1, ""));
    setOneOfCheckboxes(form, ranges2, wincasaIncomeRangeName(income2, "_2"));

    // 5) Optional: parking checkboxes (if provided)
    const wantsGarage = !!getByPath(data, "property.parking.garage");
    const wantsOutdoor = !!getByPath(data, "property.parking.outdoor");
    setCheckboxSafe(form, "Place de garage", wantsGarage);
    setCheckboxSafe(form, "Place extérieure", wantsOutdoor);

    // Debug/probing: force-check or force-uncheck specific checkbox fields by name.
    // Useful for discovering what generic fields like Oui_5 / No_5 correspond to in the PDF.
    for (const name of debugUncheck) {
      setCheckboxSafe(form, name, false);
    }
    for (const name of debugCheck) {
      setCheckboxSafe(form, name, true);
    }

    if (debugCheck.length || debugUncheck.length) {
      console.log("[wincasa probe] check:", debugCheck, "uncheck:", debugUncheck);
    }

    form.flatten();

    const outBytes = await pdfDoc.save();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="wincasa-filled.pdf"');
    return res.send(Buffer.from(outBytes));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "PDF fill failed", details: err.message });
  }
});

app.get("/debug/livit-fields", async (req, res) => {
  const templateBytes = fsSync.readFileSync(path.join(__dirname, "templates", "livit-template.pdf"));
  const pdfDoc = await PDFDocument.load(templateBytes);
  const form = pdfDoc.getForm();
  return res.json(form.getFields().map(f => f.getName()));
});

app.get("/debug/fields/livit", async (req, res) => {
  try {
    const templateBytes = fsSync.readFileSync(
      path.join(__dirname, "templates", "livit-template.pdf")
    );

    const pdfDoc = await PDFDocument.load(templateBytes);
    const form = pdfDoc.getForm();

    const fields = form.getFields().map(f => ({
      name: f.getName(),
      type: f.constructor?.name || "Unknown"
    }));

    return res.json(fields);
  }catch (err) {
    console.error(err);
    return res.status(500).json ({ error: "debug failed", details: err.message});
  }
});


app.get("/debug/fields/wincasa", async (req, res) => {
  const templateBytes = fsSync.readFileSync(
    path.join(__dirname, "templates", "wincasa-template.pdf")
  );
  const pdfDoc = await PDFDocument.load(templateBytes);
  const form = pdfDoc.getForm();
  return res.json(form.getFields().map(f => ({
    name: f.getName(),
    type: f.constructor?.name || "Unknown"
  })));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
