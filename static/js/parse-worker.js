/* Parses an uploaded workbook off the main thread so the page never freezes on big files. */
importScripts("vendor/xlsx.full.min.js", "parser.js");

self.onmessage = async (e) => {
  const { file } = e.data;
  try {
    const buffer = await file.arrayBuffer();
    const out = self.TelecomParser.parseBuffer(file.name, buffer, self.XLSX);
    self.postMessage({ ok: true, records: out.records, sheet: out.sheet });
  } catch (err) {
    self.postMessage({
      ok: false,
      user: !!(err && err.name === "UploadError"),
      error: (err && err.message) || String(err),
    });
  }
};
