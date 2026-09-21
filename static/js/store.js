/*
 * Data layer for the static version of the Telecom Site Parameters Sheet.
 *
 *  - SiteIndex : merge every stored file into one table, answer look-ups (port of SiteStore).
 *                Pure logic, no browser APIs.
 *  - Store     : keeps the parsed files in the browser (IndexedDB) and the notes (localStorage),
 *                parses uploads in a Web Worker, and exposes the same operations the Flask API had.
 *
 * Everything stays inside the visitor's own browser - nothing is ever sent anywhere.
 */
(function (root) {
  "use strict";

  const BANDS = ["g2", "u2100", "u900", "l2100", "l1800"];
  const DEFAULT_SECTORS = [1, 2, 3];

  /* ---------------------------------------------------------- helpers -- */
  const normId = (i) => i.replace(/^0+/, "") || "0";
  const isDigits = (s) => /^\d+$/.test(s);

  // Arabic-Indic / Persian digits -> ASCII, so ٩٤٩٨ finds site 9498
  function asciiDigits(s) {
    return String(s).replace(/[\u0660-\u0669]/g, (d) => d.charCodeAt(0) - 0x0660)
      .replace(/[\u06F0-\u06F9]/g, (d) => d.charCodeAt(0) - 0x06f0);
  }

  // GDTS_9498 / UTS_9498 / LXTS_9498 -> "9498" (longest digit run, first one on ties)
  function siteId(code) {
    const runs = (code || "").match(/\d+/g);
    if (!runs) return null;
    return runs.reduce((best, r) => (r.length > best.length ? r : best), runs[0]);
  }

  function fmtNum(v) {
    if (Number.isInteger(v)) return String(v);
    return String(Number(v.toPrecision(10)));
  }

  function distinct(values) {
    const seen = new Set();
    const out = [];
    for (const v of values) {
      if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) continue;
      const s = typeof v === "number" ? fmtNum(v) : String(v).trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }
  const joined = (values) => distinct(values).join(" / ");

  /* ------------------------------------------------------- SiteIndex --- */
  class SiteIndex {
    /** files: [{name, ts, records}], notes: {noteKey: text} */
    constructor(files, notes) {
      this.notes = notes || {};
      this.merged = [];
      this.byKey = new Map();
      this.sites = [];
      this.exact = new Map();
      this.ids = new Map();
      this._build(files);
    }

    _build(files) {
      // oldest upload first (ties: by name) so the newest one wins for a repeated cell
      const ordered = [...files].sort((a, b) => a.ts - b.ts || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const cells = new Map();
      for (const f of ordered) {
        for (const r of f.records) {
          const key = r.ce != null ? r.ce : `${r.sc}|${r.ly || ""}|${r.se}|${r.ci || ""}`;
          cells.delete(key); // re-insert -> keeps "last occurrence" position, like drop_duplicates(keep="last")
          cells.set(key, { ...r, source: f.name });
        }
      }
      this.merged = [...cells.values()];

      const groups = new Map();
      for (const r of this.merged) {
        if (!groups.has(r.sc)) groups.set(r.sc, []);
        groups.get(r.sc).push(r);
      }
      const keys = [...groups.keys()].sort();
      for (const key of keys) {
        const grp = groups.get(key);
        this.byKey.set(key, grp);
        const nameRow = grp.find((r) => r.sn != null);
        const name = nameRow ? nameRow.sn : key;
        const city = [...new Set(grp.map((r) => r.ct).filter((c) => c != null))]
          .find((c) => !c.toUpperCase().startsWith("UNKNOWN")) || "";
        this.sites.push({ key, code: key, name, city, code_l: key.toLowerCase(), name_l: name.toLowerCase() });
        if (!this.exact.has(key.toLowerCase())) this.exact.set(key.toLowerCase(), key);
        if (!this.exact.has(name.toLowerCase())) this.exact.set(name.toLowerCase(), key);
      }

      for (const st of this.sites) {
        const sid = siteId(st.code);
        if (sid === null) continue;
        const nk = normId(sid);
        if (!this.ids.has(nk)) this.ids.set(nk, { id: sid, keys: [], city: "" });
        const e = this.ids.get(nk);
        e.keys.push(st.key);
        e.city = e.city || st.city;
      }
    }

    /* ---- look-up ---- */
    _searchIds(q, limit) {
      const qn = normId(q);
      const exact = this.ids.get(qn);
      const starts = [...this.ids.entries()]
        .filter(([n, e]) => e.id.startsWith(q) || n.startsWith(qn))
        .map(([, e]) => e)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const hits = (exact ? [exact] : []).concat(starts.filter((e) => e !== exact));
      return hits.slice(0, limit).map((e) => ({ code: e.id, name: e.keys.join(", "), city: e.city, keys: e.keys }));
    }

    search(q, limit = 12) {
      q = asciiDigits((q || "").trim());
      const qn = q.toLowerCase();
      if (!qn) return [];
      if (isDigits(q)) return this._searchIds(q, limit).map(({ keys, ...rest }) => rest);
      const starts = [];
      const contains = [];
      for (const s of this.sites) {
        if (s.code_l.startsWith(qn) || s.name_l.startsWith(qn)) starts.push(s);
        else if (s.code_l.includes(qn) || s.name_l.includes(qn)) contains.push(s);
      }
      return starts.concat(contains).slice(0, limit).map((s) => ({ code: s.code, name: s.name, city: s.city }));
    }

    getSite(q) {
      q = asciiDigits((q || "").trim());
      const qn = q.toLowerCase();
      if (!qn) return { status: "empty" };

      if (isDigits(q)) {
        // a site number: show EVERYTHING that carries it (2G + 3G + 4G site names together)
        const hits = this._searchIds(q, 50);
        if (!hits.length) return { status: "not_found", query: q };
        if (normId(hits[0].code) === normId(q) || hits.length === 1) {
          return { status: "ok", site: this._buildSite(hits[0].keys, hits[0].code) };
        }
        return {
          status: "multiple", query: q, count: hits.length,
          matches: hits.slice(0, 12).map(({ keys, ...rest }) => rest),
        };
      }
      let key = this.exact.get(qn);
      if (key === undefined) {
        const hits = this.search(q, 50);
        if (!hits.length) return { status: "not_found", query: q };
        if (hits.length > 1) return { status: "multiple", query: q, matches: hits.slice(0, 12), count: hits.length };
        key = hits[0].code;
      }
      return { status: "ok", site: this._buildSite([key]) };
    }

    _buildSite(keys, label) {
      const grp = keys.length > 1 ? [].concat(...keys.map((k) => this.byKey.get(k))) : this.byKey.get(keys[0]);
      const key = label || keys[0];
      const isGroup = label !== undefined && label !== null;

      const present = [...new Set(grp.map((r) => r.se).filter((s) => s !== null).map((s) => Math.trunc(s)))];
      const sectors = [...new Set([...DEFAULT_SECTORS, ...present])].sort((a, b) => a - b);

      // 0 / blank coordinates are placeholders in the export, not real positions
      const xs = grp.map((r) => (r.x ? r.x : null));
      const ys = grp.map((r) => (r.y ? r.y : null));
      // NOTE: the sheet's "X Coordinate" is the export's Y column and vice-versa (as requested)

      const azimuth = {};
      for (const s of sectors) azimuth[s] = joined(grp.filter((r) => r.se === s).map((r) => r.az));

      const bands = {};
      for (const band of BANDS) {
        const sub = grp.filter((r) => r.b === band);
        bands[band] = {};
        for (const s of sectors) bands[band][s] = joined(sub.filter((r) => r.se === s).map((r) => r.v));
      }

      const nameRow = grp.find((r) => r.sn != null);
      const name = isGroup ? keys.join(", ") : nameRow ? nameRow.sn : key;
      return {
        code: key,
        name,
        region: joined(grp.map((r) => r.rg)),
        city: joined(grp.map((r) => r.ct)),
        x: joined(ys),
        y: joined(xs),
        sectors,
        azimuth,
        bands,
        cells: grp.length,
        sources: [...new Set(grp.map((r) => r.source))].sort(),
        note: this.notes[this.noteKey(key)] || "",
      };
    }

    /* ---- notes ---- */
    noteKey(site) {
      site = asciiDigits((site || "").trim());
      if (isDigits(site) && this.ids.has(normId(site))) return "id:" + normId(site);
      return site.toLowerCase();
    }

    knowsSite(site) {
      site = asciiDigits((site || "").trim());
      return (isDigits(site) && this.ids.has(normId(site))) || this.exact.has(site.toLowerCase());
    }
  }

  /* ------------------------------------------------------------ Store -- */
  const DB_NAME = "telecom-site-sheet";
  const STORE_NAME = "files";
  const NOTES_KEY = "telecom-site-sheet:notes";

  const Store = {
    files: new Map(),        // name -> {name, ts, size, rows, sites, sheet, records}
    index: new SiteIndex([], {}),
    notes: {},
    persistent: true,
    _db: null,
    _lastTs: 0,

    /* ---- IndexedDB plumbing ---- */
    _open() {
      return new Promise((resolve, reject) => {
        if (!("indexedDB" in root)) return reject(new Error("IndexedDB not available"));
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME, { keyPath: "name" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("IndexedDB error"));
        req.onblocked = () => reject(new Error("IndexedDB blocked"));
      });
    },
    _tx(mode, fn) {
      return new Promise((resolve, reject) => {
        const tx = this._db.transaction(STORE_NAME, mode);
        const res = fn(tx.objectStore(STORE_NAME));
        tx.oncomplete = () => resolve(res && res.result !== undefined ? res.result : undefined);
        tx.onerror = () => reject(tx.error || new Error("Storage write failed"));
        tx.onabort = () => reject(tx.error || new Error("Storage write failed (browser storage may be full)"));
      });
    },

    async init() {
      try { this.notes = JSON.parse(localStorage.getItem(NOTES_KEY) || "{}") || {}; } catch (_) { this.notes = {}; }
      try {
        this._db = await this._open();
        const all = await this._tx("readonly", (s) => s.getAll());
        for (const f of all || []) {
          this.files.set(f.name, f);
          this._lastTs = Math.max(this._lastTs, f.ts);
        }
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      } catch (_) {
        this.persistent = false; // e.g. private window: keep working, but only until the tab closes
      }
      this._rebuild();
    },

    _rebuild() {
      this.index = new SiteIndex([...this.files.values()], this.notes);
    },

    /* ---- status (same shape the Flask API returned) ---- */
    status() {
      const files = [...this.files.values()]
        .sort((a, b) => b.ts - a.ts)
        .map((f) => ({
          name: f.name,
          uploaded_at: new Date(f.ts).toISOString(),
          rows: f.rows,
          sites: f.sites,
          size: f.size,
          sheet: f.sheet,
        }));
      const newest = files.length ? Math.max(...[...this.files.values()].map((f) => f.ts)) : null;
      return {
        files,
        persistent: this.persistent,
        totals: {
          files: files.length,
          cells: this.index.merged.length,
          sites: this.index.sites.length,
          updated_at: newest ? new Date(newest).toISOString() : null,
        },
      };
    },

    /* ---- parsing (worker first, main thread as a fallback) ---- */
    _parseInWorker(file) {
      return new Promise((resolve, reject) => {
        let worker;
        try { worker = new Worker("static/js/parse-worker.js"); } catch (e) { return reject({ fallback: true }); }
        worker.onmessage = (e) => {
          worker.terminate();
          if (e.data.ok) resolve(e.data);
          else reject({ message: e.data.error, user: e.data.user });
        };
        worker.onerror = (e) => { worker.terminate(); e.preventDefault && e.preventDefault(); reject({ fallback: true }); };
        worker.postMessage({ file });
      });
    },

    async _parse(file) {
      const P = root.TelecomParser;
      try {
        return await this._parseInWorker(file);
      } catch (err) {
        if (!err || !err.fallback) throw new P.UploadError(err.message || "Could not read the file.");
      }
      // worker unavailable (e.g. page opened straight from disk) -> parse here
      const buffer = await file.arrayBuffer();
      return P.parseBuffer(file.name, buffer, root.XLSX);
    },

    async saveUpload(file) {
      const P = root.TelecomParser;
      const name = P.safeFilename(file.name);
      if (!name || !P.ALLOWED_EXTENSIONS.includes(P.extOf(name))) {
        throw new P.UploadError("Unsupported file type. Upload an .xlsx, .xlsm or .csv file.");
      }
      // parsed BEFORE anything stored is touched, so a bad upload can never destroy good data
      const parsed = await this._parse(file);
      const records = parsed.records;
      if (!records.length) throw new P.UploadError("The file has no usable rows (no site codes found).");

      const existing = [...this.files.keys()].find((n) => n.toLowerCase() === name.toLowerCase());
      const replaced = existing !== undefined;

      this._lastTs = Math.max(Date.now(), this._lastTs + 1);
      const entry = {
        name,
        ts: this._lastTs,
        size: file.size,
        rows: records.length,
        sites: new Set(records.map((r) => r.sc)).size,
        sheet: parsed.sheet,
        records,
      };

      if (this._db) {
        try {
          await this._tx("readwrite", (s) => {
            if (existing !== undefined && existing !== name) s.delete(existing);
            s.put(entry);
          });
        } catch (e) {
          throw new P.UploadError("The browser could not store this file (storage may be full): " + e.message);
        }
      }
      if (replaced && existing !== name) this.files.delete(existing);
      this.files.set(name, entry);
      this._rebuild();
      return { name, replaced, rows: entry.rows, sites: entry.sites, sheet: entry.sheet };
    },

    async deleteFile(name) {
      if (!this.files.has(name)) return false;
      if (this._db) await this._tx("readwrite", (s) => s.delete(name));
      this.files.delete(name);
      this._rebuild();
      return true;
    },

    /* ---- look-up + notes ---- */
    search: (q) => Store.index.search(q),
    getSite: (q) => Store.index.getSite(q),

    setNote(site, text) {
      if (!this.index.knowsSite(site)) return false;
      const nk = this.index.noteKey(site);
      text = (text || "").slice(0, 5000);
      if (text.trim()) this.notes[nk] = text;
      else delete this.notes[nk];
      try { localStorage.setItem(NOTES_KEY, JSON.stringify(this.notes)); }
      catch (_) { throw new Error("The browser could not save the note."); }
      return true;
    },
  };

  root.TelecomStore = Store;
  root.TelecomSiteIndex = SiteIndex;
  if (typeof module !== "undefined" && module.exports) module.exports = { SiteIndex, siteId, fmtNum };
})(typeof self !== "undefined" ? self : globalThis);
