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

function vilniusDateYYYYMMDD() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vilnius",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(new Date()); // YYYY-MM-DD
}

async function imageToSinglePagePdf(imageBytes) {
  const pdfDoc = await PDFDocument.create();

  let embedded;
  try {
    embedded = await pdfDoc.embedJpg(imageBytes);
  } catch {
    embedded = await pdfDoc.embedPng(imageBytes);
  }

  const { width, height } = embedded.scale(1);
  const page = pdfDoc.addPage([width, height]);
  page.drawImage(embedded, { x: 0, y: 0, width, height });

  return await pdfDoc.save();
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Trūksta ENV kintamojo: ${name}`);
  return v;
}

app.post("/upload", upload.single("photo"), async (req, res) => {
  const startedAt = Date.now();

  try {
    console.log("UPLOAD: request received");

    if (!req.file) {
      console.log("UPLOAD: no file");
      return res.status(400).json({ error: "Nėra failo (photo)." });
    }

    console.log(
      "UPLOAD: file ok",
      "size=" + req.file.size,
      "type=" + req.file.mimetype
    );

    const filename = `${vilniusDateYYYYMMDD()}.pdf`;

    console.log("UPLOAD: generating PDF...");
    const pdfBytes = await imageToSinglePagePdf(req.file.buffer);
    console.log("UPLOAD: PDF generated, bytes=" + pdfBytes.length);

    const SENDGRID_API_KEY = requireEnv("SENDGRID_API_KEY");
    const FROM_EMAIL = requireEnv("FROM_EMAIL"); // pvz. smindis@gmail.com (turi būti verified SendGrid)
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

    const ms = Date.now() - startedAt;
    console.log("UPLOAD: done in ms=" + ms);

    return res.json({ ok: true, filename });
  } catch (err) {
    console.error("UPLOAD ERROR:", err?.response?.body || err);

    return res.status(500).json({
      error:
        (err?.response?.body && JSON.stringify(err.response.body)) ||
        err?.message ||
        "Serverio klaida"
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
app.listen(port, () => console.log(`Serveris paleistas ant porto ${port}`));
