import express from "express";
import multer from "multer";
import { PDFDocument, degrees } from "pdf-lib";
import sgMail from "@sendgrid/mail";
import exifParser from "exif-parser";

const app = express();

// 15 MB limitas nuotraukai
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

// EXIF Orientation -> kiek laipsnių reikia pasukti, kad būtų "upright"
function exifOrientationToDegrees(orientation) {
  // Dažniausi telefonų variantai:
  // 1 = normal
  // 3 = 180
  // 6 = 90 CW
  // 8 = 270 CW
  switch (orientation) {
    case 3:
      return 180;
    case 6:
      return 90;
    case 8:
      return 270;
    default:
      return 0;
  }
}

function getExifOrientationDegrees(imageBytes) {
  try {
    const parsed = exifParser.create(imageBytes).parse();
    const orientation = parsed?.tags?.Orientation;
    return exifOrientationToDegrees(orientation);
  } catch {
    return 0;
  }
}

/**
 * Visada A4 portrait (595x842).
 * 1) Pirmiausia koreguojam orientaciją pagal EXIF (0/90/180/270).
 * 2) Tada, jei po korekcijos vaizdas vis dar guli (landscape),
 *    papildomai pasukam 90° kad tilptų stačiai.
 * Nekarpoma, išlaiko proporcijas, centruojama.
 */
async function imageToSinglePagePdf(imageBytes) {
  const pdfDoc = await PDFDocument.create();

  let image;
  try {
    image = await pdfDoc.embedJpg(imageBytes);
  } catch {
    image = await pdfDoc.embedPng(imageBytes);
  }

  const imgW = image.width;
  const imgH = image.height;

  // A4 stačias
  const pageW = 595;
  const pageH = 842;
  const page = pdfDoc.addPage([pageW, pageH]);

  // 1) EXIF korekcija
  const exifDeg = getExifOrientationDegrees(imageBytes);

  // Po EXIF pasukimo, "matomas" plotis/aukštis gali apsikeisti
  const exifSwaps = exifDeg === 90 || exifDeg === 270;
  const dispW1 = exifSwaps ? imgH : imgW;
  const dispH1 = exifSwaps ? imgW : imgH;

  // 2) Jei po EXIF vis dar landscape – papildomas 90° pasukimas į portrait
  const extraDeg = dispW1 > dispH1 ? 90 : 0;

  // Galutinis pasukimas (clockwise)
  const rot = (exifDeg + extraDeg) % 360;

  // Skaičiuojam "bounding box" dimensijas po rotacijos
  const bboxSwaps = rot === 90 || rot === 270;
  const bboxW = bboxSwaps ? imgH : imgW;
  const bboxH = bboxSwaps ? imgW : imgH;

  // Skalė kad tilptų į A4 (pagal bbox)
  const scale = Math.min(pageW / bboxW, pageH / bboxH);

  // Originalių (neapsikeitusių) matmenų piešimo dydžiai
  const drawW = imgW * scale;
  const drawH = imgH * scale;

  // BBox dydžiai po rotacijos (skalėje)
  const scaledBboxW = (bboxSwaps ? imgH : imgW) * scale;
  const scaledBboxH = (bboxSwaps ? imgW : imgH) * scale;

  // Centruojam bbox A4 lape
  const bx = (pageW - scaledBboxW) / 2;
  const by = (pageH - scaledBboxH) / 2;

  // Parenkam (x,y) taip, kad po rotacijos bbox prasidėtų ties (bx,by)
  // pdf-lib rotate sukasi aplink tašką (x,y)
  let x, y;

  if (rot === 0) {
    x = bx;
    y = by;
  } else if (rot === 90) {
    // bboxW = drawH, bboxH = drawW
    x = bx + drawH;
    y = by;
  } else if (rot === 180) {
    x = bx + drawW;
    y = by + drawH;
  } else {
    // 270
    x = bx;
    y = by + drawW;
  }

  page.drawImage(image, {
    x,
    y,
    width: drawW,
    height: drawH,
    rotate: degrees(rot)
  });

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

    console.log("UPLOAD: generating PDF (A4 portrait + EXIF fix)...");
    const pdfBytes = await imageToSinglePagePdf(req.file.buffer);
    console.log("UPLOAD: PDF generated, bytes=" + pdfBytes.length);

    const SENDGRID_API_KEY = requireEnv("SENDGRID_API_KEY");
    const FROM_EMAIL = requireEnv("FROM_EMAIL"); // turi būti verified SendGrid
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
