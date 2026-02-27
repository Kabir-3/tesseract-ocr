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

function safeStr(v) {
  if (v == null) return "";
  return String(v).trim();
}

function yesNoFr(v) {
  if (v === true) return "Oui";
  if (v === false) return "Non";
  return "";
}

function yesNoEn(v) {
  if (v === true) return "Yes";
  if (v === false) return "No";
  return "";
}

function chf(v) {
  const s = safeStr(v);
  return s ? `CHF ${s}` : "";
}

function normalizeCHFNumber(raw) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/[^\d.,']/g, "")
    .replace(/'/g, "")
    .replace(/\s/g, "");
  if (!cleaned) return null;
  const normalized = cleaned.includes(",") && !cleaned.includes(".")
    ? cleaned.replace(",", ".")
    : cleaned.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function findFirstMatch(text, regexList) {
  for (const rx of regexList) {
    const m = text.match(rx);
    if (m?.[1]) return safeStr(m[1]);
  }
  return "";
}

function detectDocumentLanguage(text) {
  const sample = (text || "").toLowerCase();
  const frHints = ["nom", "prénom", "date de naissance", "poursuite", "garantie", "employeur", "adresse"];
  const enHints = ["name", "date of birth", "debt", "guarantee", "employer", "address"];
  const frScore = frHints.reduce((acc, k) => acc + (sample.includes(k) ? 1 : 0), 0);
  const enScore = enHints.reduce((acc, k) => acc + (sample.includes(k) ? 1 : 0), 0);
  if (frScore === 0 && enScore === 0) return "unknown";
  return frScore >= enScore ? "fr" : "en";
}

async function extractTextFromUpload(file, preferredLang = "eng") {
  if (!file) return { fullText: "", method: "none", pages: 0, confidence: null, language: "unknown" };

  if (file.mimetype === "application/pdf") {
    const parser = new PDFParse(new Uint8Array(file.buffer));
    const textResult = await parser.getText();
    const extractedText = (textResult?.text || "").trim();

    if (extractedText.length > 50) {
      const infoResult = await parser.getInfo({ parsePageInfo: true });
      return {
        fullText: extractedText,
        method: "pdf-text-extraction",
        pages: infoResult?.total || 0,
        confidence: null,
        language: detectDocumentLanguage(extractedText)
      };
    }

    let tmpDir;
    try {
      const conv = await pdfToPngPaths(file.buffer);
      tmpDir = conv.tmpDir;

      let worker;
      try {
        worker = await createWorker(preferredLang);
      } catch {
        worker = await createWorker("eng");
      }

      const pages = [];
      let merged = "";
      let confidenceSum = 0;

      for (let i = 0; i < conv.pngs.length; i++) {
        const ocrRes = await worker.recognize(conv.pngs[i]);
        const pageText = (ocrRes.data.text || "").trim();
        const pageConfidence = ocrRes.data.confidence ?? 0;
        confidenceSum += pageConfidence;
        pages.push({ page: i + 1, confidence: pageConfidence, fullText: pageText });
        merged += pageText + "\n";
      }

      await worker.terminate();
      return {
        fullText: merged.trim(),
        method: "pdf-ocr-fallback",
        pages: pages.length,
        confidence: pages.length ? confidenceSum / pages.length : null,
        language: detectDocumentLanguage(merged)
      };
    } finally {
      await safeCleanupTmpDir(tmpDir);
    }
  }

  let worker;
  try {
    worker = await createWorker(preferredLang);
  } catch {
    worker = await createWorker("eng");
  }

  const result = await worker.recognize(file.buffer);
  await worker.terminate();

  const fullText = result.data?.text?.trim() || "";
  return {
    fullText,
    method: "image-ocr",
    pages: 1,
    confidence: result.data?.confidence ?? null,
    language: detectDocumentLanguage(fullText)
  };
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

const vaudUpload = upload.fields([
  { name: "idOrPassport", maxCount: 1 },
  { name: "debtExtract", maxCount: 1 },
  { name: "guaranteeCertificate", maxCount: 1 },
  { name: "salarySlips", maxCount: 3 },
  { name: "residencePermit", maxCount: 1 },
  { name: "employmentProof", maxCount: 1 },
  { name: "householdRcInsurance", maxCount: 1 }
]);

app.post("/vaud-intake", vaudUpload, async (req, res) => {
  try {
    const files = req.files || {};
    const idFile = files.idOrPassport?.[0];
    const debtFile = files.debtExtract?.[0];
    const guaranteeFile = files.guaranteeCertificate?.[0];
    const salaryFiles = files.salarySlips || [];
    const permitFile = files.residencePermit?.[0];
    const employmentProofFile = files.employmentProof?.[0];
    const insuranceFile = files.householdRcInsurance?.[0];

    if (!idFile || !debtFile || !guaranteeFile) {
      return res.status(400).json({
        error: "Missing required files",
        required: ["idOrPassport", "debtExtract", "guaranteeCertificate"]
      });
    }

    const idOcr = await extractTextFromUpload(idFile, "fra+eng");
    const debtOcr = await extractTextFromUpload(debtFile, "fra+eng");
    const guaranteeOcr = await extractTextFromUpload(guaranteeFile, "fra+eng");
    const permitOcr = permitFile ? await extractTextFromUpload(permitFile, "fra+eng") : null;
    const employmentOcr = employmentProofFile ? await extractTextFromUpload(employmentProofFile, "fra+eng") : null;
    const insuranceOcr = insuranceFile ? await extractTextFromUpload(insuranceFile, "fra+eng") : null;

    const salaryOcrs = [];
    for (const salaryFile of salaryFiles) {
      salaryOcrs.push(await extractTextFromUpload(salaryFile, "fra+eng"));
    }
    const salaryText = salaryOcrs.map(o => o.fullText).filter(Boolean).join("\n\n");
    const salaryConf = salaryOcrs.map(o => o.confidence).filter(v => typeof v === "number");
    const salaryConfidence = salaryConf.length ? salaryConf.reduce((a, b) => a + b, 0) / salaryConf.length : null;

    const allText = [
      idOcr.fullText,
      debtOcr.fullText,
      guaranteeOcr.fullText,
      salaryText,
      employmentOcr?.fullText || "",
      permitOcr?.fullText || "",
      insuranceOcr?.fullText || ""
    ].filter(Boolean).join("\n\n");

    const identityText = idOcr.fullText || allText;
    const debtText = debtOcr.fullText || allText;
    const guaranteeText = guaranteeOcr.fullText || allText;
    const employmentText = `${employmentOcr?.fullText || ""}\n${salaryText}\n${allText}`;

    const firstName = findFirstMatch(identityText, [/(?:pr[ée]nom|first\s*name)\s*[:\-]\s*([^\n\r]{2,80})/i]);
    const lastName = findFirstMatch(identityText, [/(?:nom(?:\s*de\s*famille)?|last\s*name|surname)\s*[:\-]\s*([^\n\r]{2,80})/i]);
    const dateOfBirth = findFirstMatch(identityText, [/(?:date\s*de\s*naissance|date\s*of\s*birth|n[ée]\s*le)\s*[:\-]?\s*([0-3]?\d[./-][01]?\d[./-]\d{2,4})/i]);
    const nationality = findFirstMatch(identityText, [/(?:nationalit[ée]|nationality)\s*[:\-]\s*([^\n\r]{2,80})/i]);
    const documentNumber = findFirstMatch(identityText, [/(?:passeport|passport|id|document)\s*(?:n[°o]|number|num[ée]ro)?\s*[:\-]?\s*([A-Z0-9-]{5,30})/i]);
    const email = findFirstMatch(allText, [/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i]);
    const phone = findFirstMatch(allText, [/\b(\+41[\s\d()./-]{7,}|0\d[\d\s()./-]{7,})\b/]);
    const currentAddress = findFirstMatch(allText, [/(?:adresse|address)\s*[:\-]\s*([^\n\r]{5,120})/i]);
    const employer = findFirstMatch(employmentText, [/(?:employeur|employer)\s*[:\-]\s*([^\n\r]{2,120})/i]);
    const role = findFirstMatch(employmentText, [/(?:poste|fonction|profession|role|position)\s*[:\-]\s*([^\n\r]{2,120})/i]);
    const incomeRaw = findFirstMatch(employmentText, [
      /(?:revenu|salaire|income)\s*[:\-]?\s*(?:chf|fr\.?)?\s*([0-9'.,\s]{3,20})/i,
      /\b(?:chf|fr\.?)\s*([0-9'.,\s]{3,20})/i
    ]);
    const monthlyNetIncome = normalizeCHFNumber(incomeRaw);
    const debtExtractDate = findFirstMatch(debtText, [/(?:date\s*(?:de\s*l['’])?extrait|date\s*d['’][ée]mission|issued\s*on)\s*[:\-]?\s*([0-3]?\d[./-][01]?\d[./-]\d{2,4})/i]);
    const activeCountRaw = findFirstMatch(debtText, [/(\d+)\s*(?:poursuite|poursuites|debt\s*case|debt\s*cases)/i]);
    const activePursuitsCount = activeCountRaw ? Number(activeCountRaw) : null;
    const debtExtractStatus = /aucune?\s+(?:poursuite|inscription)|sans\s+poursuite|ne\s+comporte\s+aucune/i.test(debtText)
      ? "clear"
      : /(?:poursuite|poursuites|debt)\b/i.test(debtText)
        ? "records_found"
        : "";
    const guaranteeAmountRaw = findFirstMatch(guaranteeText, [/(?:montant|garantie|deposit|caution)\s*[:\-]?\s*(?:chf|fr\.?)?\s*([0-9'.,\s]{3,20})/i]);
    const guaranteeAmount = normalizeCHFNumber(guaranteeAmountRaw);
    const guaranteeProvider = findFirstMatch(guaranteeText, [/(?:fournisseur\s*de\s*garantie|provider|garant(?:ie)?)\s*[:\-]\s*([^\n\r]{2,120})/i]);
    const permitType = findFirstMatch(permitOcr?.fullText || allText, [/\b(?:permis|permit)\s*[:\-]?\s*([BCLG])\b/i]);

    const profile = {
      locale: "fr-CH",
      canton: "VD",
      applicant: {
        first_name: firstName,
        last_name: lastName,
        full_name: `${firstName} ${lastName}`.trim(),
        date_of_birth: dateOfBirth,
        nationality,
        phone,
        email,
        current_address: currentAddress,
        permit_type: permitType,
        document_number: documentNumber
      },
      employment: {
        status: findFirstMatch(allText, [/(?:statut|status)\s*[:\-]\s*([^\n\r]{2,80})/i]),
        employer,
        role,
        contract_type: findFirstMatch(allText, [/(?:contrat|contract)\s*[:\-]\s*([^\n\r]{2,80})/i]),
        monthly_net_income_chf: monthlyNetIncome
      },
      financial: {
        debt_extract_date: debtExtractDate,
        debt_extract_status: debtExtractStatus,
        active_pursuits_count: activePursuitsCount,
        guarantee_amount_chf: guaranteeAmount,
        guarantee_provider: guaranteeProvider
      },
      documents: {
        id_or_passport: { provided: !!idFile, language: idOcr.language, confidence: idOcr.confidence },
        debt_extract: { provided: !!debtFile, language: debtOcr.language, confidence: debtOcr.confidence },
        guarantee_certificate: { provided: !!guaranteeFile, language: guaranteeOcr.language, confidence: guaranteeOcr.confidence },
        salary_slips_3m: { provided: salaryFiles.length > 0, language: detectDocumentLanguage(salaryText), confidence: salaryConfidence },
        residence_permit: { provided: !!permitFile, language: permitOcr?.language || "unknown", confidence: permitOcr?.confidence ?? null },
        employment_proof: { provided: !!employmentProofFile, language: employmentOcr?.language || "unknown", confidence: employmentOcr?.confidence ?? null },
        household_rc_insurance: { provided: !!insuranceFile, language: insuranceOcr?.language || "unknown", confidence: insuranceOcr?.confidence ?? null }
      }
    };

    const missingRequired = [
      !profile.documents.id_or_passport.provided ? "id_or_passport" : null,
      !profile.documents.debt_extract.provided ? "debt_extract" : null,
      !profile.documents.guarantee_certificate.provided ? "guarantee_certificate" : null
    ].filter(Boolean);

    const cvInput = {
      identity: {
        firstName: profile.applicant.first_name,
        lastName: profile.applicant.last_name,
        dateOfBirth: profile.applicant.date_of_birth,
        nationality: profile.applicant.nationality,
        documentType: profile.documents.id_or_passport.provided ? "ID/Passport" : "",
        documentNumber: profile.applicant.document_number
      },
      contact: {
        currentAddress: profile.applicant.current_address,
        phone: profile.applicant.phone,
        email: profile.applicant.email
      },
      employment: {
        employer: profile.employment.employer,
        position: profile.employment.role,
        annualIncomeCHF: profile.employment.monthly_net_income_chf
      },
      financial: {
        debtExtractDate: profile.financial.debt_extract_date,
        hasDebtRecord: profile.financial.debt_extract_status === "records_found",
        guaranteeAmountCHF: profile.financial.guarantee_amount_chf,
        guaranteeProvider: profile.financial.guarantee_provider
      },
      documents: {
        idUploaded: profile.documents.id_or_passport.provided,
        debtExtractUploaded: profile.documents.debt_extract.provided,
        guaranteeUploaded: profile.documents.guarantee_certificate.provided
      }
    };

    return res.json({
      profile: {
        ...profile,
        missing_required_docs: missingRequired,
        cv_ready: Boolean(cvInput.identity.firstName && cvInput.identity.lastName && cvInput.documents.idUploaded && cvInput.documents.debtExtractUploaded && cvInput.documents.guaranteeUploaded)
      },
      cv_input: cvInput,
      extraction_meta: {
        id_or_passport: { method: idOcr.method, pages: idOcr.pages, language: idOcr.language },
        debt_extract: { method: debtOcr.method, pages: debtOcr.pages, language: debtOcr.language },
        guarantee_certificate: { method: guaranteeOcr.method, pages: guaranteeOcr.pages, language: guaranteeOcr.language },
        salary_slips_3m: { method: salaryFiles.length ? "multi-file" : "none", pages: salaryOcrs.reduce((sum, o) => sum + (o.pages || 0), 0), language: detectDocumentLanguage(salaryText) }
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Vaud intake failed", details: err.message });
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

// Generate bilingual tenant CV PDF from JSON
app.post("/generate-cv", async (req, res) => {
  try {
    const body = req.body || {};
    // Accept either direct payload or wrapped: { data: {...} }
    const data = body.data ?? body;

    const identity = data.identity ?? {};
    const contact = data.contact ?? {};
    const employment = data.employment ?? {};
    const financial = data.financial ?? {};
    const documents = data.documents ?? {};

    const pdfDoc = await PDFDocument.create();

    // --- Page 1: French ---
    const pageFr = pdfDoc.addPage([595.28, 841.89]); // A4
    const { height: h1 } = pageFr.getSize();

    // Header bar
    pageFr.drawRectangle({
      x: 0,
      y: h1 - 80,
      width: 595.28,
      height: 80,
    });

    const margin = 50;
    let y = h1 - margin;

    const titleSize = 18;
    const headingSize = 12;
    const textSize = 11;
    const lineGap = 16;

    const draw = (page, txt, x, y, size = textSize) => {
      page.drawText(txt ?? "", { x, y, size });
    };

    // Title (polished)
    draw(pageFr, "Canton de Vaud – Dossier locataire", margin, h1 - 45, 16);
    y -= 60;

    // Identity
    draw(pageFr, "Identité", margin, y, headingSize);
    pageFr.drawLine({
      start: { x: margin, y: y - 6 },
      end: { x: 545, y: y - 6 },
      thickness: 0.5
    });
    y -= 18;
    draw(pageFr, `Nom: ${safeStr(identity.firstName)} ${safeStr(identity.lastName)}`.trim(), margin, y);
    y -= lineGap;
    draw(pageFr, `Date de naissance: ${safeStr(identity.dateOfBirth)}`, margin, y);
    y -= lineGap;
    draw(pageFr, `Nationalité: ${safeStr(identity.nationality)}`, margin, y);
    y -= lineGap;
    draw(pageFr, `Document: ${safeStr(identity.documentType)} ${safeStr(identity.documentNumber)}`.trim(), margin, y);
    y -= 26;

    // Contact
    draw(pageFr, "Coordonnées", margin, y, headingSize);
    pageFr.drawLine({
      start: { x: margin, y: y - 6 },
      end: { x: 545, y: y - 6 },
      thickness: 0.5
    });
    y -= 18;
    draw(pageFr, `Adresse actuelle: ${safeStr(contact.currentAddress)}`, margin, y);
    y -= lineGap;
    draw(pageFr, `Téléphone: ${safeStr(contact.phone)}`, margin, y);
    y -= lineGap;
    draw(pageFr, `Email: ${safeStr(contact.email)}`, margin, y);
    y -= 26;

    // Employment
    draw(pageFr, "Situation professionnelle", margin, y, headingSize);
    pageFr.drawLine({
      start: { x: margin, y: y - 6 },
      end: { x: 545, y: y - 6 },
      thickness: 0.5
    });
    y -= 18;
    draw(pageFr, `Employeur: ${safeStr(employment.employer)}`, margin, y);
    y -= lineGap;
    draw(pageFr, `Poste: ${safeStr(employment.position)}`, margin, y);
    y -= lineGap;
    draw(pageFr, `Revenu annuel: ${safeStr(employment.annualIncomeCHF) ? chf(employment.annualIncomeCHF) : ""}`, margin, y);
    y -= 26;

    // Financial
    draw(pageFr, "Situation financière", margin, y, headingSize);
    pageFr.drawLine({
      start: { x: margin, y: y - 6 },
      end: { x: 545, y: y - 6 },
      thickness: 0.5
    });
    y -= 18;
    draw(pageFr, `Extrait des poursuites (date): ${safeStr(financial.debtExtractDate)}`, margin, y);
    y -= lineGap;
    draw(pageFr, `A des poursuites / dettes: ${yesNoFr(financial.hasDebtRecord)}`, margin, y);
    y -= lineGap;
    draw(pageFr, `Garantie: ${safeStr(financial.guaranteeAmountCHF) ? chf(financial.guaranteeAmountCHF) : ""}`, margin, y);
    y -= lineGap;
    draw(pageFr, `Fournisseur garantie: ${safeStr(financial.guaranteeProvider)}`, margin, y);
    y -= 26;

    // Documents
    draw(pageFr, "Documents fournis", margin, y, headingSize);
    pageFr.drawLine({
      start: { x: margin, y: y - 6 },
      end: { x: 545, y: y - 6 },
      thickness: 0.5
    });
    y -= 18;
    draw(pageFr, `ID/Passport: ${yesNoFr(documents.idUploaded)}`, margin, y);
    y -= lineGap;
    draw(pageFr, `Extrait des poursuites: ${yesNoFr(documents.debtExtractUploaded)}`, margin, y);
    y -= lineGap;
    draw(pageFr, `Certificat de garantie: ${yesNoFr(documents.guaranteeUploaded)}`, margin, y);

    // Footer (polished)
    draw(pageFr, `Généré le: ${new Date().toISOString().slice(0, 10)}  |  Informations fournies par le candidat`, margin, 25, 8);

    // --- Page 2: English ---
    const pageEn = pdfDoc.addPage([595.28, 841.89]);
    const { height: h2 } = pageEn.getSize();

    // Header bar
    pageEn.drawRectangle({
      x: 0,
      y: h2 - 80,
      width: 595.28,
      height: 80,
    });

    y = h2 - margin;
    // Title (polished)
    draw(pageEn, "Canton of Vaud – Tenant Dossier", margin, h2 - 45, 16);
    y -= 60;

    draw(pageEn, "Identity", margin, y, headingSize);
    pageEn.drawLine({
      start: { x: margin, y: y - 6 },
      end: { x: 545, y: y - 6 },
      thickness: 0.5
    });
    y -= 18;
    draw(pageEn, `Name: ${safeStr(identity.firstName)} ${safeStr(identity.lastName)}`.trim(), margin, y);
    y -= lineGap;
    draw(pageEn, `Date of birth: ${safeStr(identity.dateOfBirth)}`, margin, y);
    y -= lineGap;
    draw(pageEn, `Nationality: ${safeStr(identity.nationality)}`, margin, y);
    y -= lineGap;
    draw(pageEn, `Document: ${safeStr(identity.documentType)} ${safeStr(identity.documentNumber)}`.trim(), margin, y);
    y -= 26;

    draw(pageEn, "Contact", margin, y, headingSize);
    pageEn.drawLine({
      start: { x: margin, y: y - 6 },
      end: { x: 545, y: y - 6 },
      thickness: 0.5
    });
    y -= 18;
    draw(pageEn, `Current address: ${safeStr(contact.currentAddress)}`, margin, y);
    y -= lineGap;
    draw(pageEn, `Phone: ${safeStr(contact.phone)}`, margin, y);
    y -= lineGap;
    draw(pageEn, `Email: ${safeStr(contact.email)}`, margin, y);
    y -= 26;

    draw(pageEn, "Employment", margin, y, headingSize);
    pageEn.drawLine({
      start: { x: margin, y: y - 6 },
      end: { x: 545, y: y - 6 },
      thickness: 0.5
    });
    y -= 18;
    draw(pageEn, `Employer: ${safeStr(employment.employer)}`, margin, y);
    y -= lineGap;
    draw(pageEn, `Role: ${safeStr(employment.position)}`, margin, y);
    y -= lineGap;
    draw(pageEn, `Annual income: ${safeStr(employment.annualIncomeCHF) ? chf(employment.annualIncomeCHF) : ""}`, margin, y);
    y -= 26;

    draw(pageEn, "Financial", margin, y, headingSize);
    pageEn.drawLine({
      start: { x: margin, y: y - 6 },
      end: { x: 545, y: y - 6 },
      thickness: 0.5
    });
    y -= 18;
    draw(pageEn, `Debt extract date: ${safeStr(financial.debtExtractDate)}`, margin, y);
    y -= lineGap;
    draw(pageEn, `Debt record: ${yesNoEn(financial.hasDebtRecord)}`, margin, y);
    y -= lineGap;
    draw(pageEn, `Guarantee: ${safeStr(financial.guaranteeAmountCHF) ? chf(financial.guaranteeAmountCHF) : ""}`, margin, y);
    y -= lineGap;
    draw(pageEn, `Guarantee provider: ${safeStr(financial.guaranteeProvider)}`, margin, y);
    y -= 26;

    draw(pageEn, "Documents provided", margin, y, headingSize);
    pageEn.drawLine({
      start: { x: margin, y: y - 6 },
      end: { x: 545, y: y - 6 },
      thickness: 0.5
    });
    y -= 18;
    draw(pageEn, `ID/Passport: ${yesNoEn(documents.idUploaded)}`, margin, y);
    y -= lineGap;
    draw(pageEn, `Debt extract: ${yesNoEn(documents.debtExtractUploaded)}`, margin, y);
    y -= lineGap;
    draw(pageEn, `Guarantee certificate: ${yesNoEn(documents.guaranteeUploaded)}`, margin, y);

    // Footer (polished)
    draw(pageEn, `Generated on: ${new Date().toISOString().slice(0, 10)}  |  Information provided by applicant`, margin, 25, 8);

    const outBytes = await pdfDoc.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="tenant-profile-bilingual.pdf"');
    return res.send(Buffer.from(outBytes));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "CV generation failed", details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
