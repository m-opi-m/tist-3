(() => {
  "use strict";

  /* ------------------------------------------------------------ helpers -- */
  const $ = (s) => document.querySelector(s);
  const el = {
    site: $("#siteInput"), clear: $("#clearBtn"), suggest: $("#suggest"), msg: $("#msg"),
    region: $("#region"), city: $("#city"), x: $("#xCoord"), y: $("#yCoord"),
    table: $("#table"), caption: $("#caption"),
    notes: $("#notes"), saved: $("#saved"),
    snap: $("#snapBtn"),
    drop: $("#drop"), fileInput: $("#fileInput"), dropTitle: $("#dropTitle"), dropHint: $("#dropHint"),
    progress: $("#progress"), bar: $("#progressBar"),
    stats: $("#stats"), statsLine: $("#statsLine"), statsSub: $("#statsSub"),
    filesBtn: $("#filesBtn"), filesCount: $("#filesCount"), files: $("#files"), fileList: $("#fileList"),
    toasts: $("#toasts"),
  };
  const DROP_HINT = el.dropHint.innerHTML;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => Number(n || 0).toLocaleString("en-US");
  const fmtDate = (iso) => {
    if (!iso) return "-";
    const d = new Date(iso);
    return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");

  // Every icon is embedded as literal SVG markup (no <use>/<symbol> sprite refs) - sprite
  // refs aren't reliably captured by the "download as image" exporter.
  const ICONS = {
    tower: { vb: "0 0 48 48", body: `<g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17.2 7a10 10 0 0 0 0 10"/><path d="M30.8 7a10 10 0 0 1 0 10"/><path d="M12.6 3.6a16 16 0 0 0 0 16.8"/><path d="M35.4 3.6a16 16 0 0 1 0 16.8"/><path d="M24 15 14 44M24 15l10 29"/><path d="M20.5 25h7M16.4 37h15.2M20.5 25l11.1 12M27.5 25 16.4 37M12 44h24"/></g><circle cx="24" cy="12" r="2.8" fill="currentColor"/>` },
    compass: { vb: "0 0 48 48", body: `<circle cx="24" cy="24" r="17" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M24 3v6M24 39v6M3 24h6M39 24h6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M24 10 28.6 19.4 38 24l-9.4 4.6L24 38l-4.6-9.4L10 24l9.4-4.6z" fill="currentColor"/>` },
    hex3: { vb: "0 0 60 56", body: `<path d="M26 7 43 16.5v21L26 47 9 37.5v-21z" fill="currentColor" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/><text x="26" y="33.5" text-anchor="middle" font-size="19" font-weight="700" fill="#fff">3G</text><g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M41 9a13 13 0 0 1 11 11"/><path d="M43 2.5A20 20 0 0 1 58 19"/></g>` },
    hex4: { vb: "0 0 60 56", body: `<path d="M26 7 43 16.5v21L26 47 9 37.5v-21z" fill="currentColor" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/><text x="26" y="33.5" text-anchor="middle" font-size="19" font-weight="700" fill="#fff">4G</text><g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M41 9a13 13 0 0 1 11 11"/><path d="M43 2.5A20 20 0 0 1 58 19"/></g>` },
    file: { vb: "0 0 48 48", body: `<g fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4h17l9 9v29a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M29 4v9h9"/><path d="M17 24h14M17 31h14M17 38h8"/></g>` },
    trash: { vb: "0 0 48 48", body: `<g fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12h32M18 12V7h12v5M12 12l2 30h20l2-30M20 20v14M28 20v14"/></g>` },
  };
  const icon = (name, cls = "") => {
    const ic = ICONS[name];
    if (!ic) return "";
    return `<svg class="ic ${cls}" viewBox="${ic.vb}" aria-hidden="true">${ic.body}</svg>`;
  };

  const store = window.TelecomStore;   // all data lives in this browser (see static/js/store.js)

  function toast(text, kind = "info", sub = "", ms = 5500) {
    const t = document.createElement("div");
    t.className = "toast " + kind;
    t.innerHTML = esc(text) + (sub ? `<small>${esc(sub)}</small>` : "");
    el.toasts.appendChild(t);
    setTimeout(() => t.remove(), kind === "err" ? Math.max(ms, 9000) : ms);
  }

  /* ---------------------------------------------------- sheet rendering -- */
  const BLOCKS = [
    { kind: "single", theme: "blue", key: "azimuth", label: "Azimuth (°)", icon: "compass" },
    { kind: "single", theme: "green", key: "g2", label: "2G (BCCH)", icon: "tower" },
    { kind: "group", theme: "teal", hex: "hex3", title: "3G", sub: "(PSC)", rows: [["u2100", "Band 2100"], ["u900", "Band 900"]] },
    { kind: "group", theme: "purple", hex: "hex4", title: "4G", sub: "(PCI)", rows: [["l2100", "Band 2100"], ["l1800", "Band 1800"]] },
  ];

  const valueHtml = (v, hasSite) => {
    const val = v || (hasSite ? "N/A" : "");
    const len = val.length;
    const cls = len > 16 ? "xlong" : len > 8 ? "long" : "";
    const naCls = !v && hasSite ? " na" : "";
    return `<span class="v ${cls}${naCls}">${esc(val)}</span>`;
  };

  function renderTable(site) {
    const sectors = site ? site.sectors : [1, 2, 3];
    const get = (key, s) => {
      if (!site) return "";
      const src = key === "azimuth" ? site.azimuth : site.bands[key];
      return (src && src[String(s)]) || "";
    };

    let html = `<div class="thead"><div class="th th-param">Parameter</div>` +
      sectors.map((s) => `<div class="th">Sector ${s}</div>`).join("") + `</div>`;

    for (const b of BLOCKS) {
      if (b.kind === "single") {
        html += `<div class="blk single ${b.theme}">
          <div class="lab">${icon(b.icon)}<span>${esc(b.label)}</span></div>` +
          sectors.map((s) => `<div class="cell">${valueHtml(get(b.key, s), !!site)}</div>`).join("") + `</div>`;
      } else {
        html += `<div class="blk group ${b.theme}">
          <div class="grp">${icon(b.hex)}<div class="gt"><span>${b.title}</span><small>${b.sub}</small></div></div>`;
        b.rows.forEach(([key, label], i) => {
          const r = i + 1, cls = i === 0 ? "r1" : "";
          html += `<div class="band ${cls}" style="grid-row:${r}">${esc(label)}</div>` +
            sectors.map((s) => `<div class="cell ${cls}"><div class="val">${valueHtml(get(key, s), !!site)}</div></div>`).join("");
        });
        html += `</div>`;
      }
    }
    el.table.style.setProperty("--n", sectors.length);
    el.table.innerHTML = html;
  }

  const state = { site: null, seq: 0, noteTimer: null, noteSite: null, activeIdx: -1, matches: [] };

  function renderSite(site) {
    state.site = site;
    el.region.value = site ? site.region : "";
    el.city.value = site ? site.city : "";
    el.x.value = site ? site.x : "";
    el.y.value = site ? site.y : "";
    renderTable(site);
    el.snap.disabled = !site;

    if (site) {
      const from = site.sources.join(", ");
      el.caption.hidden = false;
      el.caption.textContent = `${site.name} · ${num(site.cells)} cells · source: ${from}`;
      el.notes.disabled = false;
      el.notes.placeholder = "";
      if (document.activeElement !== el.notes) el.notes.value = site.note || "";
    } else {
      el.caption.hidden = true;
      el.notes.disabled = true;
      el.notes.value = "";
      el.notes.placeholder = "Select a site to add notes";
    }
  }

  function setMsg(text, isError = false) {
    el.msg.hidden = !text;
    el.msg.textContent = text || "";
    el.msg.classList.toggle("error", !!isError);
  }

  /* ------------------------------------------------------------- search -- */
  function closeSuggest() {
    el.suggest.hidden = true;
    el.site.setAttribute("aria-expanded", "false");
    state.activeIdx = -1;
  }

  function openSuggest(matches, header = "") {
    state.matches = matches;
    state.activeIdx = -1;
    el.suggest.innerHTML = (header ? `<li class="hd" aria-hidden="true">${esc(header)}</li>` : "") +
      matches.map((m, i) =>
        `<li role="option" data-i="${i}"><b>${esc(m.code)}</b>${m.city ? `<span>${esc(m.city)}</span>` : ""}</li>`).join("");
    el.suggest.hidden = !matches.length;
    el.site.setAttribute("aria-expanded", String(!!matches.length));
  }

  function highlight(i) {
    const items = [...el.suggest.querySelectorAll("li[data-i]")];
    if (!items.length) return;
    state.activeIdx = (i + items.length) % items.length;
    items.forEach((li, k) => li.setAttribute("aria-selected", String(k === state.activeIdx)));
    items[state.activeIdx].scrollIntoView({ block: "nearest" });
  }

  async function lookup(q, { commit = false, silent = false } = {}) {
    const mySeq = ++state.seq;
    q = q.trim();
    if (!q) { renderSite(null); setMsg(""); closeSuggest(); return; }
    let r;
    try { r = store.getSite(q); }
    catch (e) { if (!silent) setMsg(e.message, true); return; }
    if (mySeq !== state.seq) return;               // a newer keystroke won

    if (r.status === "ok") {
      renderSite(r.site);
      closeSuggest();
      setMsg("");
      if (commit) el.site.value = r.site.code;
    } else if (r.status === "multiple") {
      renderSite(null);
      setMsg("");
      openSuggest(r.matches, `${r.count} sites match "${q}" - pick one` + (r.count > r.matches.length ? " (showing first " + r.matches.length + ")" : ""));
    } else {
      renderSite(null);
      closeSuggest();
      setMsg(state.hasData ? `No site found for "${q}"` : "No data loaded yet - upload your Excel file first", true);
    }
  }

  let typingTimer = null;
  el.site.addEventListener("input", () => {
    el.clear.hidden = !el.site.value;
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => lookup(el.site.value), 180);
  });
  el.site.addEventListener("keydown", (e) => {
    const open = !el.suggest.hidden;
    if (e.key === "ArrowDown") { if (open) { e.preventDefault(); highlight(state.activeIdx + 1); } }
    else if (e.key === "ArrowUp") { if (open) { e.preventDefault(); highlight(state.activeIdx - 1); } }
    else if (e.key === "Escape") { closeSuggest(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(typingTimer);
      if (open && state.activeIdx >= 0) { pick(state.matches[state.activeIdx].code); }
      else { lookup(el.site.value, { commit: true }); }
    }
  });
  el.suggest.addEventListener("mousedown", (e) => {   // mousedown: fires before the input loses focus
    const li = e.target.closest("li[data-i]");
    if (li) { e.preventDefault(); pick(state.matches[+li.dataset.i].code); }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".field")) closeSuggest(); });
  el.clear.addEventListener("click", () => {
    el.site.value = ""; el.clear.hidden = true; lookup(""); el.site.focus();
  });

  function pick(code) {
    el.site.value = code;
    el.clear.hidden = false;
    lookup(code, { commit: true });
  }

  /* -------------------------------------------------------------- notes -- */
  async function saveNote(site, text) {
    try {
      if (!store.setNote(site, text)) throw new Error("Unknown site.");
      if (state.site && state.site.code === site) state.site.note = text;
      el.saved.textContent = "Saved";
      el.saved.classList.add("on");
      setTimeout(() => el.saved.classList.remove("on"), 1400);
    } catch (e) { toast("Could not save the note", "err", e.message); }
  }
  function flushNote() {
    if (state.noteTimer) {
      clearTimeout(state.noteTimer); state.noteTimer = null;
      if (state.noteSite) saveNote(state.noteSite, el.notes.value);
    }
  }
  el.notes.addEventListener("input", () => {
    if (!state.site) return;
    state.noteSite = state.site.code;
    clearTimeout(state.noteTimer);
    const text = el.notes.value;
    const site = state.noteSite;
    state.noteTimer = setTimeout(() => { state.noteTimer = null; saveNote(site, text); }, 700);
  });
  el.notes.addEventListener("blur", flushNote);

  /* -------------------------------------------------------- data source -- */
  state.hasData = false;

  function renderStatus(st) {
    const t = st.totals;
    state.hasData = t.files > 0;
    el.filesCount.textContent = t.files;
    el.stats.classList.toggle("empty", !state.hasData);
    if (state.hasData) {
      el.statsLine.textContent = `${num(t.files)} file${t.files > 1 ? "s" : ""} · ${num(t.cells)} cells · ${num(t.sites)} sites`;
      el.statsSub.textContent = `Last update: ${fmtDate(t.updated_at)}`;
      el.site.placeholder = "Type site code or name";
    } else {
      el.statsLine.textContent = "No data yet";
      el.statsSub.textContent = "Upload your Excel file to start";
      el.site.placeholder = "Upload a data file first";
    }

    el.fileList.innerHTML = st.files.length ? st.files.map((f) => `
      <li>
        ${icon("file")}
        <div class="file-info">
          <b title="${esc(f.name)}">${esc(f.name)}</b>
          <span>${fmtDate(f.uploaded_at)} · ${num(f.rows)} cells · ${num(f.sites)} sites · ${fmtSize(f.size)}${f.sheet && f.sheet !== "csv" ? ` · sheet "${esc(f.sheet)}"` : ""}</span>
        </div>
        <button type="button" class="del" data-name="${esc(f.name)}" title="Delete this file" aria-label="Delete ${esc(f.name)}">${icon("trash")}</button>
      </li>`).join("") : `<li class="no-files">No files stored yet.</li>`;
  }

  function refreshStatus() {
    renderStatus(store.status());
    if (!store.persistent) {
      toast("Private mode detected", "err",
        "Your browser can't keep files between visits here - uploaded data will be lost when you close this tab.", 12000);
    }
  }

  el.filesBtn.addEventListener("click", () => {
    const open = el.files.hidden;
    el.files.hidden = !open;
    el.filesBtn.setAttribute("aria-expanded", String(open));
  });

  el.fileList.addEventListener("click", async (e) => {
    const btn = e.target.closest(".del");
    if (!btn) return;
    const name = btn.dataset.name;
    if (!confirm(`Delete "${name}" from the app?\nSites that exist only in this file will disappear.`)) return;
    try {
      if (!(await store.deleteFile(name))) throw new Error("File not found.");
      renderStatus(store.status());
      toast(`Deleted "${name}"`, "ok");
      if (el.site.value.trim()) lookup(el.site.value, { silent: true });
    } catch (err) { toast("Delete failed", "err", err.message); }
  });

  /* ------------------------------------------------------------- upload -- */
  function setBusy(on, text) {
    el.drop.classList.toggle("busy", on);
    el.progress.hidden = !on;
    el.progress.classList.remove("indet");
    el.bar.style.width = "0";
    el.dropTitle.textContent = on ? text : "Upload Excel file";
    el.dropHint.innerHTML = on ? "Please wait&hellip;" : DROP_HINT;
  }

  const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  async function upload(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    flushNote();
    setBusy(true, files.length > 1 ? `Reading ${files.length} files…` : `Reading ${files[0].name}…`);
    el.progress.classList.add("indet");
    let okCount = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        el.dropTitle.textContent = files.length > 1 ? `Processing ${i + 1} of ${files.length}: ${f.name}` : `Processing ${f.name}…`;
        await nextPaint();
        try {
          const r = await store.saveUpload(f);
          okCount++;
          const totalFiles = store.status().totals.files;
          toast(`${r.replaced ? "Replaced" : "Added"} "${r.name}"`, "ok",
            `${num(r.rows)} cells · ${num(r.sites)} sites` +
            (r.replaced ? " · the old file with the same name was overwritten"
              : totalFiles > 1 ? " · merged with the existing files" : ""));
        } catch (e) {
          toast(`Rejected "${f.name}"`, "err", e.message);
        }
      }
      renderStatus(store.status());
      if (okCount) {
        // refresh whatever is on screen with the new data
        const q = state.site ? state.site.code : el.site.value;
        if (q.trim()) await lookup(q, { silent: true });
      }
    } catch (e) {
      toast("Upload failed", "err", e.message);
    } finally {
      setBusy(false);
      el.fileInput.value = "";
    }
  }

  el.fileInput.addEventListener("change", () => upload(el.fileInput.files));

  // drag & drop - anywhere on the page
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; el.drop.classList.add("over"); } });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; el.drop.classList.remove("over"); } });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; el.drop.classList.remove("over");
    upload(e.dataTransfer.files);
  });

  /* ----------------------------------------------------------- snapshot -- */
  // Sections left out of the exported image entirely (matches the print
  // stylesheet): the upload/data-source bar, and small in-page UI chrome
  // (clear button, suggestion dropdown, search status message).
  const SNAPSHOT_HIDE_IDS = new Set(["source"]);
  const SNAPSHOT_HIDE_CLASSES = ["clear", "suggest", "msg"];

  async function downloadSnapshot() {
    if (!state.site || el.snap.disabled) return;
    if (typeof domtoimage === "undefined") {
      toast("Image export isn't available", "err", "The snapshot library failed to load");
      return;
    }
    flushNote();
    el.snap.classList.add("busy");
    el.snap.disabled = true;
    const node = document.getElementById("sheet");
    try {
      const dataUrl = await domtoimage.toPng(node, {
        bgcolor: "#ffffff",
        // The exporter copies the sheet's computed style into the image. Force zero margin (and no
        // drop-shadow) on the exported copy and give it the exact size, so the sheet always fills
        // the PNG edge-to-edge - never shifted to one side / cropped on the other.
        width: node.offsetWidth,
        height: node.offsetHeight,
        style: { margin: "0", boxShadow: "none" },
        filter: (n) => {
          if (n.id && SNAPSHOT_HIDE_IDS.has(n.id)) return false;
          if (n.classList) {
            for (const c of SNAPSHOT_HIDE_CLASSES) { if (n.classList.contains(c)) return false; }
          }
          return true;
        },
      });
      const link = document.createElement("a");
      link.download = `${state.site.code || "site"}-parameters.png`;
      link.href = dataUrl;
      link.click();
    } catch (e) {
      toast("Could not create the image", "err", e.message);
    } finally {
      el.snap.classList.remove("busy");
      el.snap.disabled = !state.site;
    }
  }
  el.snap.addEventListener("click", downloadSnapshot);

  /* --------------------------------------------------------------- boot -- */
  renderTable(null);
  renderSite(null);
  store.init().then(() => {
    refreshStatus();
    el.site.focus();
    // a site number in the address bar (e.g. ...#9498) opens that site straight away
    const hash = decodeURIComponent(location.hash.slice(1)).trim();
    if (hash) { el.site.value = hash; el.clear.hidden = false; lookup(hash, { commit: true }); }
  });
})();
