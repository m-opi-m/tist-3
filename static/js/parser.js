/*
 * File parsing for the Telecom Site Parameters Sheet (static version).
 * Direct port of parse_file() / _read_table() from the original Python data_store.py.
 *
 * Works in three places (same code):  a Web Worker,  the page itself (fallback),  Node (tests).
 * Needs the SheetJS "XLSX" object, passed in as an argument.
 */
(function (root) {
  "use strict";

  const ALLOWED_EXTENSIONS = [".xlsx", ".xlsm", ".csv"];

  // canonical name -> accepted header spellings (compared upper-case, spaces -> _)
  const COLUMN_ALIASES = {
    site_code: ["SITE_CODE", "SITECODE"],
    site_name: ["SITE_NAME", "SITENAME"],
    layer: ["LAYER"],
    sector: ["SECTORID", "SECTOR_ID", "SECTOR"],
    bcch: ["BCCH"],
    psc: ["PSC"],
    pci: ["PCI"],
    azimuth: ["AZIMUTH"],
    x: ["X"],
    y: ["Y"],
    region: ["REGION"],
    city: ["CITY"],
    cell: ["CELLNAME", "CELL_NAME"],
    cellid: ["CELLID", "CELL_ID"],
  };

  const BAND_VALUE_COLUMN = { g2: "bcch", u2100: "psc", u900: "psc", l2100: "pci", l1800: "pci" };

  class UploadError extends Error {
    constructor(message) {
      super(message);
      this.name = "UploadError";
    }
  }

  /* ----------------------------------------------------------- helpers -- */
  function safeFilename(name) {
    name = String(name || "").replace(/\\/g, "/").split("/").pop();
    name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^[ .]+|[ .]+$/g, "");
    return name.slice(0, 150);
  }

  function extOf(name) {
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(i).toLowerCase() : "";
  }

  function classifyLayer(layer) {
    if (!layer) return null;
    const s = layer.toUpperCase();
    if (s.includes("U9")) return "u900";
    if (s.includes("U21")) return "u2100";
    if (s.includes("L21")) return "l2100";
    if (s.includes("L18")) return "l1800";
    if (s.includes("G")) return "g2";
    return null;
  }

  function cleanText(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return null;
      return String(v);
    }
    if (v instanceof Date) return v.toISOString();
    const s = String(v).trim();
    return s || null;
  }

  function toNum(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "boolean") return null;
    const s = String(v).trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function normHeader(h) {
    return String(h).trim().toUpperCase().replace(/\s+/g, "_");
  }

  function mapColumns(headerRow) {
    const byNorm = new Map();
    (headerRow || []).forEach((h, i) => {
      if (h === null || h === undefined) return;
      const k = normHeader(h);
      if (!byNorm.has(k)) byNorm.set(k, i);
    });
    const found = {};
    for (const [canon, aliases] of Object.entries(COLUMN_ALIASES)) {
      for (const a of aliases) {
        if (byNorm.has(a)) {
          found[canon] = byNorm.get(a);
          break;
        }
      }
    }
    return found;
  }

  function missingRequired(found) {
    const missing = [];
    if (!("site_code" in found) && !("site_name" in found)) missing.push("SITE_CODE / SITE_NAME");
    if (!("layer" in found)) missing.push("Layer");
    if (!("sector" in found)) missing.push("SectorID");
    return missing;
  }

  function decodeCsv(buf) {
    const bytes = new Uint8Array(buf);
    for (const enc of ["utf-8", "windows-1256", "windows-1252"]) {
      try {
        return new TextDecoder(enc, { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
      } catch (_) { /* try the next encoding */ }
    }
    throw new UploadError("Could not read the CSV file (unknown text encoding).");
  }

  const sheetRows = (XLSX, ws) => XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  /* ------------------------------------------------------- read a table -- */
  function readTable(XLSX, buffer, ext) {
    if (ext === ".csv") {
      const wb = XLSX.read(decodeCsv(buffer), { type: "string", raw: true });
      const rows = sheetRows(XLSX, wb.Sheets[wb.SheetNames[0]]);
      const found = mapColumns(rows[0]);
      const missing = missingRequired(found);
      if (missing.length) throw new UploadError("Missing required column(s): " + missing.join(", "));
      return { rows, found, sheet: "csv" };
    }

    let names;
    try {
      names = XLSX.read(buffer, { type: "array", bookSheets: true }).SheetNames.slice();
    } catch (e) {
      throw new UploadError("Could not open the workbook: " + (e && e.message ? e.message : e));
    }
    // the sheet called "data" first, then the rest in workbook order (stable sort)
    names = names
      .map((n, i) => ({ n, i }))
      .sort((a, b) => (a.n.trim().toLowerCase() !== "data") - (b.n.trim().toLowerCase() !== "data") || a.i - b.i)
      .map((o) => o.n);

    let lastMissing = null;
    for (const name of names) {
      let found;
      try {
        const peek = XLSX.read(buffer, { type: "array", sheets: name, sheetRows: 3, dense: true });
        found = mapColumns(sheetRows(XLSX, peek.Sheets[name])[0]);
      } catch (_) {
        continue;
      }
      const missing = missingRequired(found);
      if (missing.length) {
        lastMissing = missing;
        continue;
      }
      const wb = XLSX.read(buffer, { type: "array", sheets: name, dense: true });
      return { rows: sheetRows(XLSX, wb.Sheets[name]), found, sheet: name };
    }
    const hint = (lastMissing || ["SITE_CODE / SITE_NAME", "Layer", "SectorID"]).join(", ");
    throw new UploadError(
      "No sheet with the cell table was found. Expected a sheet (usually called 'data') " +
        "with columns such as " + hint + "."
    );
  }

  /* ------------------------------------------------- normalise the rows -- */
  // record keys: sc site_code, sn site_name, ly layer, ce cell, ci cellid, rg region, ct city,
  //              se sector, az azimuth, x, y, b band, v value (BCCH / PSC / PCI for that band)
  function parseBuffer(name, buffer, XLSX) {
    const ext = extOf(name);
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new UploadError("Unsupported file type. Upload an .xlsx, .xlsm or .csv file.");
    }
    const { rows, found, sheet } = readTable(XLSX, buffer, ext);
    const g = (r, canon) => (canon in found ? r[found[canon]] : null);

    const records = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r) continue;
      let sc = cleanText(g(r, "site_code"));
      let sn = cleanText(g(r, "site_name"));
      if (sc == null) sc = sn;
      if (sn == null) sn = sc;
      if (sc == null) continue;

      const ly = (cleanText(g(r, "layer")) || "").toUpperCase() || null;
      const b = classifyLayer(ly);
      const src = b ? BAND_VALUE_COLUMN[b] : null;
      records.push({
        sc, sn, ly,
        ce: cleanText(g(r, "cell")),
        ci: cleanText(g(r, "cellid")),
        rg: cleanText(g(r, "region")),
        ct: cleanText(g(r, "city")),
        se: toNum(g(r, "sector")),
        az: toNum(g(r, "azimuth")),
        x: toNum(g(r, "x")),
        y: toNum(g(r, "y")),
        b,
        v: src ? toNum(g(r, src)) : null,
      });
    }
    return { records, sheet };
  }

  const api = { parseBuffer, UploadError, safeFilename, extOf, classifyLayer, ALLOWED_EXTENSIONS };
  root.TelecomParser = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
