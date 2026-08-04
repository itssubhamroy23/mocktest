const fs = require("fs");
const path = require("path");
const { createCanvas } = require("@napi-rs/canvas");

async function renderPdf(pdfPath, outDir, prefix) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjsLib.getDocument({ data });
  const doc = await loadingTask.promise;
  fs.mkdirSync(outDir, { recursive: true });

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    const outPath = path.join(outDir, `${prefix}-page-${String(i).padStart(2, "0")}.png`);
    fs.writeFileSync(outPath, canvas.toBuffer("image/png"));
    console.log(outPath);
  }
}

async function main() {
  const dir = path.join(__dirname, "..", "source-pdfs");
  const outDir = path.join(dir, "pages");
  await renderPdf(
    path.join(dir, "GS_JR_Manager_APGCL_12_2023_dated_25_04_2023.pdf"),
    outDir,
    "qpaper"
  );
  await renderPdf(
    path.join(dir, "GS_ans_key_Jr_Manager_APGCL_12_2023.pdf"),
    outDir,
    "answerkey"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
