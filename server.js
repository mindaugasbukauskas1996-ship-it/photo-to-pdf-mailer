import express from "express";
import multer from "multer";
import nodemailer from "nodemailer";
import { PDFDocument } from "pdf-lib";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

app.use(express.static("public"));

function vilniusDateYYYYMMDD() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vilnius",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(new Date());
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

app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    console.log("UPLOAD: request received");
    if (!req.file) {
      return res.status(400).json({ error: "Nėra failo" });
    }

    const filename = `${vilniusDateYYYYMMDD()}.pdf`;

    const pdfBytes = await imageToSinglePagePdf(req.file.buffer);

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to: "mindaugas.bukauskas@manobustas.lt",
      subject: `PDF ${filename}`,
      text: "Pridedamas PDF failas",
      attachments: [
        {
          filename,
          content: Buffer.from(pdfBytes),
          contentType: "application/pdf"
        }
      ]
    });

    res.json({ ok: true, filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Serveris paleistas"));
