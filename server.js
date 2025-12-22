import express from "express";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import sgMail from "@sendgrid/mail";

const app = express();

// 15 MB limitas nuotraukai
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

app.use(express.static("public"));

// Health check (patogiam testui)
app.get("/health", (req, res) => res.json({ ok: true }));

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Trūksta ENV kintamojo: ${name}`);
  return v;
}

// Europe/Vilnius data kaip YYYY-MM-DD (pavadinimui)
function vilniusDateYYYYMMDD() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vilnius",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(new Date());
}

// 1 nuotrauka -> 1 puslapio PDF (spalvotas)
async function imageToSinglePagePdf(imageBytes) {
  const pdfDoc = await PDFDocument.create();

  // Bandome JPG, jei nepavyksta – PNG
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
    const FROM_EMAIL = requireEnv("FROM_EMAIL"); // turi būti verified SendGrid
    const TO_EMAIL = process.env.TO_EMAIL || "mindaugas.bukauskas@manobustas.lt";

    // Nustatom API key (SendGrid Web API per HTTPS)
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
    // SendGrid klaidos dažnai būna err.response.body
    const sgBody = err?.response?.body;
    if (sgBody) {
      console.error("UPLOAD ERROR (SendGrid):", JSON.stringify(sgBody));
    } else {
      console.error("UPLOAD ERROR:", err);
    }

    return res.status(500).json({
      error:
        (sgBody && JSON.stringify(sgBody)) ||
        err?.message ||
        "Serverio klaida"
    });
  }
});

// Aiškus atsakas, jei failas per didelis
app.use((err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Nuotrauka per didelė (limit 15MB)." });
  }
  return next(err);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`START: SENDGRID API MODE, port=${port}`));
