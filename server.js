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

function vilniusDateYYYYMMDD() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vilnius",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(new Date());
}

// Visada A4 portrait, be pasukimų serveryje.
// (Pasukimą padarome naršyklėje per preview.)
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

    console.log("UPLOAD: file ok size=" + req.file.size + " type=" + req.file.mimetype);

    const filename = `${vilniusDateYYYYMMDD()}.pdf`;

    console.log("UPLOAD: generating PDF (A4 portrait)...");
    const pdfBytes = await imageToA4PortraitPdf(req.file.buffer);
    console.log("UPLOAD: PDF generated, bytes=" + pdfBytes.length);

    const SENDGRID_API_KEY = requireEnv("SENDGRID_API_KEY");
    const FROM_EMAIL = requireEnv("FROM_EMAIL");
    const TO_EMAIL = process.env.TO_EMAIL || "mindaugas.bukauskas@manobustas.lt";

    sgMail.setApiKey(SENDGRID_API_KEY);

    console.log("UPLOAD: sending via SendGrid Web API...");
    await sgMail.send({
      to: TO_EMAIL,
      from: FROM_EMAIL,
      subject: `PDF ${filename}`,
      text: `Pridedamas PDF failas: ${filename}`,
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

    return res.json({ ok: true, filename });
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
app.listen(port, () => console.log(`START: SENDGRID API MODE, port=${port}`));
