import express from "express";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import sgMail from "@sendgrid/mail";

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

app.use(express.static("public"));
app.get("/health", (req, res) => res.json({ ok: true }));

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Trūksta ENV kintamojo: ${name}`);
  return v;
}

function sanitizeForFilename(input) {
  // failų sistemoms ir el. pašto priedams saugiau
  return String(input || "")
    .trim()
    .replace(/[\/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "") // pabaigoje taškų nepaliekam
    .slice(0, 140);
}

function buildSubjectAndFilename(accountNoRaw, addressRaw) {
  const accountNo = String(accountNoRaw || "").trim();
  const address = String(addressRaw || "").trim();

  const base = sanitizeForFilename(`${accountNo} – ${address}`);
  const safeBase = base || "Dokumentas";

  return {
    subject: safeBase,
    filename: `${safeBase}.pdf`
  };
}

// Visada A4 portrait. Pasukimą darome naršyklėje per preview.
async function imageToA4PortraitPdf(imageBytes) {
  const pdfDoc = await PDFDocument.create();

  let image;
  try {
    image = await pdfDoc.embedJpg(imageBytes);
  } catch {
    image = await pdfDoc.embedPng(imageBytes);
  }

  const imgW = image.width;
  const imgH = image.height;

  // A4 portrait points
  const pageW = 595;
  const pageH = 842;

  const page = pdfDoc.addPage([pageW, pageH]);

  const scale = Math.min(pageW / imgW, pageH / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;

  const x = (pageW - drawW) / 2;
  const y = (pageH - drawH) / 2;

  page.drawImage(image, { x, y, width: drawW, height: drawH });

  return await pdfDoc.save();
}

app.post("/upload", upload.single("photo"), async (req, res) => {
  const startedAt = Date.now();

  try {
    console.log("UPLOAD: request received");

    if (!req.file) {
      return res.status(400).json({ error: "Nėra failo (photo)." });
    }

    const accountNo = req.body?.accountNo;
    const address = req.body?.address;

    if (!accountNo || !String(accountNo).trim()) {
      return res.status(400).json({ error: "Neįvestas Paskyros nr." });
    }
    if (!address || !String(address).trim()) {
      return res.status(400).json({ error: "Neįvestas Adresas." });
    }

    const { subject, filename } = buildSubjectAndFilename(accountNo, address);

    console.log("UPLOAD: file ok size=" + req.file.size + " type=" + req.file.mimetype);
    console.log("UPLOAD: subject=" + subject);
    console.log("UPLOAD: filename=" + filename);

    console.log("UPLOAD: generating PDF...");
    const pdfBytes = await imageToA4PortraitPdf(req.file.buffer);
    console.log("UPLOAD: PDF generated, bytes=" + pdfBytes.length);

    const SENDGRID_API_KEY = requireEnv("SENDGRID_API_KEY");
    const FROM_EMAIL = requireEnv("FROM_EMAIL");
    const TO_EMAIL = process.env.TO_EMAIL || "mindaugas.bukauskas@manobustas.lt";

    sgMail.setApiKey(SENDGRID_API_KEY);

    console.log("UPLOAD: sending email...");
    await sgMail.send({
      to: TO_EMAIL,
      from: FROM_EMAIL,
      subject,
      text:
        `Pridedamas PDF failas: ${filename}\n` +
        `Paskyros nr.: ${String(accountNo).trim()}\n` +
        `Adresas: ${String(address).trim()}`,
      attachments: [
        {
          content: Buffer.from(pdfBytes).toString("base64"),
          filename,
          type: "application/pdf",
          disposition: "attachment"
        }
      ]
    });

    console.log("UPLOAD: email sent");
    console.log("UPLOAD: done in ms=" + (Date.now() - startedAt));

    return res.json({ ok: true, filename, subject });
  } catch (err) {
    const sgBody = err?.response?.body;
    if (sgBody) console.error("UPLOAD ERROR (SendGrid):", JSON.stringify(sgBody));
    else console.error("UPLOAD ERROR:", err);

    return res.status(500).json({
      error: (sgBody && JSON.stringify(sgBody)) || err?.message || "Serverio klaida"
    });
  }
});

app.use((err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Nuotrauka per didelė (limit 15MB)." });
  }
  return next(err);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`START: port=${port}`));
