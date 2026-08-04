const fs = require("fs");
const path = require("path");
const { PDFParse } = require("pdf-parse");

async function extract(pdfPath, outPath) {
  const buf = fs.readFileSync(pdfPath);
  const parser = new PDFParse({ data: buf });
  const data = await parser.getText();
  await parser.destroy();
  fs.writeFileSync(outPath, data.text);
  console.log(`${pdfPath} -> ${outPath} (${data.total} pages, ${data.text.length} chars)`);
}

async function main() {
  const dir = path.join(__dirname, "..", "source-pdfs");
  const outDir = path.join(__dirname, "..", "source-pdfs", "extracted");
  fs.mkdirSync(outDir, { recursive: true });
  await extract(
    path.join(dir, "GS_JR_Manager_APGCL_12_2023_dated_25_04_2023.pdf"),
    path.join(outDir, "question-paper.txt")
  );
  await extract(
    path.join(dir, "GS_ans_key_Jr_Manager_APGCL_12_2023.pdf"),
    path.join(outDir, "answer-key.txt")
  );
}

main();
