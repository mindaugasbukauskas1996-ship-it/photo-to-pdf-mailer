import express from "express";
import multer from "multer";
import nodemailer from "nodemailer";
import { PDFDocument } from "pdf-lib";

const app = express();

// 15 MB limitas; jei nuotraukos labai didelės – sumažinsime vėliau
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

app.use(express.static("public"));

// Paprastas health check (naudinga testui naršyklėje)
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

  // Bandome kaip JPG, jei nepavyksta – kaip PNG
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

    // PDF failo pavadinimas: tik data
    const filename = `${vilniusDateYYYYMMDD()}.pdf`;

    console.log("UPLOAD: generating PDF...");
    const pdfBytes = await imageToSinglePagePdf(req.file.buffer);
    console.log("UPLOAD: PDF generated, bytes=" + pdfBytes.length);

    // SMTP konfigūracija iš ENV
    const SMTP_HOST = requireEnv("SMTP_HOST");
    const SMTP_PORT = Number(requireEnv("SMTP_PORT"));
    const SMTP_SECURE = (process.env.SMTP_SECURE || "false").toLowerCase() === "true";
    const SMTP_USER = requireEnv("SMTP_USER");
    const SMTP_PASS = requireEnv("SMTP_PASS");

    const FROM_EMAIL = process.env.FROM_EMAIL || SMTP_USER;
    const TO_EMAIL = process.env.TO_EMAIL || "mindaugas.bukauskas@manobustas.lt";

    console.log(
      "UPLOAD: SMTP config",
      `host=${SMTP_HOST}`,
      `port=${SMTP_PORT}`,
      `secure=${SMTP_SECURE}`,
      `user=${SMTP_USER}`,
      `from=${FROM_EMAIL}`,
      `to=${TO_EMAIL}`
    );

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE, // true jei 465
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // Apsauga nuo „amžino“ siuntimo pakibimo:
      connectionTimeout: 20_000, // 20s
      greetingTimeout: 20_000,
      socketTimeout: 30_000
    });

    // Patikrina SMTP prisijungimą prieš siunčiant (gausite aiškią klaidą loguose)
    console.log("UPLOAD: verifying SMTP...");
    await transporter.verify();
    console.log("UPLOAD: SMTP verified");

    console.log("UPLOAD: sending email...");
    await transporter.sendMail({
      from: FROM_EMAIL,
      to: TO_EMAIL,
      subject: `PDF ${filename}`,
      text: `Pridedamas PDF failas: ${filename}`,
      attachments: [
        {
          filename,
          content: Buffer.from(pdfBytes),
          contentType: "application/pdf"
        }
      ]
    });
    console.log("UPLOAD: email sent");

    const ms = Date.now() - startedAt;
    console.log("UPLOAD: done in ms=" + ms);

    return res.json({ ok: true, filename });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);

    // Grąžinam aiškią klaidą į puslapį
    return res.status(500).json({
      error: err?.message || "Serverio klaida"
    });
  }
});

// Aiškesnis JSON atsakas, jei failas per didelis
app.use((err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Nuotrauka per didelė (limit 15MB)." });
  }
  return next(err);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Serveris paleistas ant porto ${port}`));
