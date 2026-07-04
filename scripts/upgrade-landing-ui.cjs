const fs = require("fs");
const path = "app/page.tsx";
let page = fs.readFileSync(path, "utf8");

if (!page.includes('const [activePage, setActivePage]')) {
  page = page.replace(
    '  const [serverOnline, setServerOnline] = useState(false);',
    '  const [serverOnline, setServerOnline] = useState(false);\n  const [activePage, setActivePage] = useState<"home" | "scanner" | "vault" | "reports" | "upload" | "help">("home");'
  );
}

const start = page.indexOf('  return <main');
const end = page.lastIndexOf('</main>;');
if (start < 0 || end < 0) throw new Error('Could not find current return <main> block');

const replacement = `  const navItems = [
    { id: "home", label: "Dashboard", icon: "✦" },
    { id: "scanner", label: "Scanner", icon: "⌁" },
    { id: "vault", label: "Script Vault", icon: "▣" },
    { id: "reports", label: "Reports", icon: "↗" },
    { id: "upload", label: "FRED Upload", icon: "⬡" },
    { id: "help", label: "Help", icon: "?" },
  ] as const;

  const activeTitle = navItems.find((item) => item.id === activePage)?.label || "Dashboard";
  const unmatchedTotal = unmatchedDispensed.length + unmatchedOriginals.length;

  return <main className="min-h-screen overflow-hidden bg-[#f6f1e8] text-slate-950">
    {toast && <div className="fixed inset-x-4 top-5 z-50 mx-auto max-w-xl rounded-full bg-slate-950 px-6 py-4 text-center text-sm font-black text-white shadow-2xl ring-4 ring-white/70">✓ {toast}</div>}

    <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(circle_at_15%_10%,rgba(20,184,166,0.22),transparent_28rem),radial-gradient(circle_at_90%_0%,rgba(251,191,36,0.18),transparent_30rem),linear-gradient(180deg,#fff8ed_0%,#f6f1e8_48%,#e9f7f4_100%)]" />

    <nav className="sticky top-0 z-40 border-b border-slate-900/10 bg-[#fff8ed]/85 px-4 py-3 backdrop-blur-2xl sm:px-6 lg:px-10">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
        <button onClick={() => setActivePage("home")} className="flex items-center gap-3 rounded-full bg-slate-950 px-4 py-2 text-white shadow-xl">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-300 text-lg text-slate-950">Rx</span>
          <span className="hidden text-left sm:block"><b className="block text-sm leading-4">Owing Matcher</b><span className="text-[11px] text-white/65">Pharmacy workflow hub</span></span>
        </button>
        <div className="hidden items-center gap-1 rounded-full border border-slate-900/10 bg-white/70 p-1 shadow-sm lg:flex">
          {navItems.map((item) => <button key={item.id} onClick={() => setActivePage(item.id)} className={(activePage === item.id ? "bg-slate-950 text-white shadow-lg " : "text-slate-600 hover:bg-white ") + "rounded-full px-4 py-2 text-sm font-black"}>{item.label}</button>)}
        </div>
        <button onClick={() => setActivePage("scanner")} className="rounded-full bg-emerald-500 px-5 py-3 text-sm font-black text-slate-950 shadow-xl shadow-emerald-900/10">Start scan</button>
      </div>
      <div className="mx-auto mt-3 flex max-w-7xl gap-2 overflow-x-auto pb-1 lg:hidden">
        {navItems.map((item) => <button key={item.id} onClick={() => setActivePage(item.id)} className={(activePage === item.id ? "bg-slate-950 text-white " : "bg-white/70 text-slate-600 ") + "shrink-0 rounded-full px-4 py-2 text-xs font-black shadow-sm"}>{item.icon} {item.label}</button>)}
      </div>
    </nav>

    <section className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-10">
      <div className="mb-5 flex flex-col gap-3 rounded-[2rem] border border-white/70 bg-white/70 p-4 shadow-xl shadow-slate-900/5 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
        <div><p className="text-xs font-black uppercase tracking-[0.24em] text-emerald-700">{activeTitle}</p><p className="mt-1 text-sm font-bold text-slate-600">{message}</p></div>
        <div className="flex flex-wrap gap-2 text-xs font-black"><span className={(serverOnline ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800") + " rounded-full px-3 py-2"}>{serverOnline ? "Server storage online" : "Browser backup mode"}</span><span className="rounded-full bg-slate-100 px-3 py-2 text-slate-700">{scripts.length ? "FRED " + masterRange.from + " → " + masterRange.to : "No FRED master yet"}</span></div>
      </div>

      {activePage === "home" && <div className="space-y-6">
        <section className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="relative overflow-hidden rounded-[2.5rem] bg-slate-950 p-7 text-white shadow-2xl shadow-slate-900/25 sm:p-10">
            <div className="absolute -right-20 -top-20 h-72 w-72 rounded-full bg-emerald-400/30 blur-3xl" />
            <div className="absolute bottom-0 right-8 hidden h-48 w-48 rounded-t-full bg-[#f4d06f]/70 lg:block" />
            <p className="relative text-xs font-black uppercase tracking-[0.32em] text-emerald-300">Script reconciliation, simplified</p>
            <h1 className="relative mt-4 max-w-3xl text-4xl font-black leading-[0.95] tracking-[-0.06em] sm:text-6xl">Match owing scripts without chasing paper.</h1>
            <p className="relative mt-5 max-w-xl text-base leading-7 text-white/70">Scan dispensed copies, save original scripts, and let the vault separate matched, unmatched, and review items in one shared pharmacy workspace.</p>
            <div className="relative mt-7 flex flex-wrap gap-3"><button onClick={() => setActivePage("scanner")} className="rounded-full bg-emerald-400 px-6 py-4 font-black text-slate-950 shadow-xl">Open scanner</button><button onClick={() => setActivePage("vault")} className="rounded-full border border-white/20 bg-white/10 px-6 py-4 font-black text-white">View vault</button></div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            {[{ label: "Matched pairs", value: matchedPairs.length, hint: "Ready to reconcile", tone: "bg-emerald-100" }, { label: "Needs review", value: unmatchedTotal, hint: "Unmatched copies + originals", tone: "bg-amber-100" }, { label: "Saved dispensed", value: scans.length, hint: "Server backed", tone: "bg-cyan-100" }, { label: "Original items", value: originals.length, hint: "Paper scripts saved", tone: "bg-violet-100" }].map((card) => <button key={card.label} onClick={() => setActivePage(card.label === "Matched pairs" ? "vault" : card.label === "Needs review" ? "reports" : "vault")} className={card.tone + " rounded-[2rem] p-5 text-left shadow-xl shadow-slate-900/5"}><p className="text-4xl font-black tracking-[-0.06em]">{card.value}</p><p className="mt-2 text-sm font-black">{card.label}</p><p className="text-xs font-bold text-slate-500">{card.hint}</p></button>)}
          </div>
        </section>
        <section className="grid gap-4 lg:grid-cols-3">
          {[{ title: "1. Scan dispensed", body: "Barcode first. If there is no barcode, AI reads the patient copy or repeat authorisation." }, { title: "2. Save originals", body: "Scan or manually enter original paper scripts when they arrive." }, { title: "3. Review vault", body: "Matched pairs are separated from unmatched work items for export." }].map((step) => <div key={step.title} className="rounded-[2rem] bg-white p-6 shadow-xl shadow-slate-900/5"><p className="text-lg font-black">{step.title}</p><p className="mt-2 text-sm leading-6 text-slate-600">{step.body}</p></div>)}
        </section>
      </div>}

      {activePage === "scanner" && <section className={(flash ? "ring-4 ring-emerald-300 " : "") + "rounded-[2.5rem] bg-white p-5 shadow-2xl shadow-slate-900/10 sm:p-7"}>
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-black uppercase tracking-[0.25em] text-emerald-700">Smart scanner</p><h2 className="text-3xl font-black tracking-[-0.04em]">Capture, read, save.</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Use Dispensed Copy for labels, repeat authorisations and patient copies. Use Original Script only for the actual original paper prescription.</p></div><div className="grid grid-cols-2 gap-2"><button onClick={() => startScanner("dispensed_copy")} className={(mode === "dispensed_copy" ? "bg-emerald-500 text-slate-950" : "bg-slate-100 text-slate-700") + " rounded-full px-5 py-3 text-sm font-black"}>Dispensed Copy</button><button onClick={() => startScanner("original_script")} className={(mode === "original_script" ? "bg-slate-950 text-white" : "bg-slate-100 text-slate-700") + " rounded-full px-5 py-3 text-sm font-black"}>Original Script</button></div></div>
        <div className="grid gap-5 lg:grid-cols-[380px_1fr]"><div><div className="relative overflow-hidden rounded-[2rem] border-4 border-slate-950 bg-slate-100 shadow-inner"><video ref={videoRef} className="h-72 w-full object-cover" autoPlay muted playsInline /><div className="pointer-events-none absolute inset-x-10 top-1/2 h-20 -translate-y-1/2 rounded-3xl border-4 border-white/90 shadow-[0_0_0_9999px_rgba(15,23,42,0.16)]" /></div><div className="mt-3 grid grid-cols-2 gap-2"><button onClick={() => startScanner(mode)} className="rounded-full bg-emerald-500 px-4 py-3 font-black text-slate-950">Start camera</button><button onClick={stopScanner} className="rounded-full bg-slate-950 px-4 py-3 font-black text-white">Stop</button></div></div>
          <div className="grid gap-4"><div className="rounded-[2rem] bg-slate-50 p-5"><p className="text-xs font-black uppercase tracking-widest text-slate-500">Detected barcode / script number</p><p className="mt-2 min-h-12 break-all text-4xl font-black tracking-[-0.06em]">{value || "No barcode"}</p></div><button onClick={saveCurrentScan} disabled={scannerBusy || (!cameraOn && !value.trim())} className="rounded-[2rem] bg-slate-950 px-6 py-6 text-xl font-black text-white shadow-xl disabled:opacity-40">{scannerBusy ? "Reading..." : mode === "dispensed_copy" ? "Save / AI Scan Dispensed Copy" : "AI Scan Original Script"}</button><div className="grid gap-3 rounded-[2rem] bg-[#f8f3ea] p-5 sm:grid-cols-2"><label className="text-sm font-black text-slate-600">Manual script/label<input value={manual} onChange={(e) => { setManual(e.target.value); setDetected(""); }} placeholder="e.g. 50676193" className="mt-2 w-full rounded-2xl border border-slate-200 bg-white p-4 text-lg font-black" /></label><div className="rounded-2xl border border-slate-200 bg-white p-4"><p className="text-xs font-black uppercase text-slate-500">Preview</p>{preview?.record ? <div><p className="font-black text-emerald-700">FRED match found</p><p>{preview.record.patient}</p><p className="text-sm text-slate-600">{preview.record.medicine}</p><p className="text-sm text-slate-600">{auDate(preview.record.dispenseDate)}</p></div> : <p className="font-bold text-amber-700">{value ? "No FRED match yet" : "Nothing to save"}</p>}</div></div></div>
        </div>
      </section>}

      {activePage === "vault" && <section className="rounded-[2.5rem] bg-white p-5 shadow-2xl shadow-slate-900/10 sm:p-7"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-black uppercase tracking-[0.25em] text-emerald-700">Script vault</p><h2 className="text-3xl font-black tracking-[-0.04em]">Matched and unmatched work items</h2></div><button onClick={() => downloadCsv(tableMode + "-owing-script-matcher.csv", tableRows)} disabled={tableRows.length === 0} className="rounded-full bg-slate-950 px-5 py-3 text-sm font-black text-white disabled:opacity-40">Export CSV</button></div><div className="mt-5 flex flex-wrap gap-2">{[{ id: "matched", label: "Matched pairs", count: matchedPairs.length }, { id: "unmatchedDispensed", label: "Unmatched dispensed", count: unmatchedDispensed.length }, { id: "unmatchedOriginals", label: "Unmatched originals", count: unmatchedOriginals.length }].map((tab) => <button key={tab.id} onClick={() => setTableMode(tab.id as TableMode)} className={(tableMode === tab.id ? "bg-slate-950 text-white" : "bg-slate-100 text-slate-700") + " rounded-full px-4 py-3 text-sm font-black"}>{tab.label} · {tab.count}</button>)}</div><div className="mt-5 max-h-[58vh] overflow-auto rounded-[1.5rem] border border-slate-200"><table className="w-full min-w-[980px] text-left text-sm"><thead className="sticky top-0 bg-slate-50"><tr>{["Status", "DispensedCopy", "Script", "Patient", "Address", "Date", "Medicine", "DocumentType", "DispensedTime", "OriginalTime"].map((h) => <th key={h} className="p-3 font-black">{h}</th>)}</tr></thead><tbody>{tableRows.length === 0 ? <tr><td colSpan={10} className="p-8 text-center text-slate-500">No rows yet.</td></tr> : tableRows.map((row, index) => <tr key={index} className="border-t hover:bg-emerald-50/60"><td className="p-3 font-black">{row.Status}</td><td className="p-3">{row.DispensedCopy}</td><td className="p-3">{row.Script}</td><td className="p-3">{row.Patient}</td><td className="p-3">{row.Address}</td><td className="p-3">{row.Date}</td><td className="p-3">{row.Medicine}</td><td className="p-3">{row.DocumentType}</td><td className="p-3">{row.DispensedTime}</td><td className="p-3">{row.OriginalTime}</td></tr>)}</tbody></table></div></section>}

      {activePage === "reports" && <section className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]"><div className="rounded-[2.5rem] bg-slate-950 p-6 text-white shadow-2xl"><p className="text-xs font-black uppercase tracking-[0.25em] text-emerald-300">Reports</p><h2 className="mt-2 text-3xl font-black tracking-[-0.04em]">Daily reconciliation summary</h2><div className="mt-6 grid gap-3 sm:grid-cols-2">{[{ label: "Matched", value: matchedPairs.length }, { label: "Unmatched", value: unmatchedTotal }, { label: "FRED rows", value: scripts.length }, { label: "Uploads", value: batches.length }].map((x) => <div key={x.label} className="rounded-[1.5rem] bg-white/10 p-4"><p className="text-3xl font-black">{x.value}</p><p className="text-xs font-bold text-white/60">{x.label}</p></div>)}</div><div className="mt-5 grid gap-2 sm:grid-cols-3"><button onClick={clearScans} className="rounded-full bg-amber-200 px-3 py-3 text-sm font-black text-amber-950">Clear dispensed</button><button onClick={clearOriginals} className="rounded-full bg-amber-200 px-3 py-3 text-sm font-black text-amber-950">Clear originals</button><button onClick={clearMaster} className="rounded-full bg-red-200 px-3 py-3 text-sm font-black text-red-950">Clear FRED</button></div></div><div className="rounded-[2.5rem] bg-white p-6 shadow-2xl shadow-slate-900/10"><h2 className="text-2xl font-black">Recent activity</h2><div className="mt-4 space-y-3">{recentItems.length === 0 ? <p className="text-slate-500">Nothing saved yet.</p> : recentItems.map((item, idx) => <div key={idx} className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4"><p className="text-xs font-black uppercase text-slate-500">{item.kind}</p><p className="font-black">{item.title}</p><p className="text-sm text-slate-600">{item.subtitle}</p><p className="text-xs text-slate-400">{fmt(item.time)}</p></div>)}</div></div></section>}

      {activePage === "upload" && <section className="rounded-[2.5rem] bg-slate-950 p-6 text-white shadow-2xl"><p className="text-xs font-black uppercase tracking-[0.25em] text-emerald-300">FRED upload</p><h2 className="mt-2 text-3xl font-black tracking-[-0.04em]">Upload the master file</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-white/65">Upload FRED Excel or CSV. Existing script numbers update; old rows stay unless replaced.</p><label className="mt-6 flex cursor-pointer flex-col items-center justify-center rounded-[2rem] border-2 border-dashed border-emerald-300 bg-white/10 p-10 text-center"><span className="text-2xl font-black">Tap to upload FRED file</span><span className="mt-2 text-sm text-white/60">xlsx, xls, csv, txt</span><input type="file" accept=".xlsx,.xls,.csv,.txt" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); e.currentTarget.value = ""; }} /></label>{uploadState.active && <div className="mt-5"><div className="h-3 overflow-hidden rounded-full bg-white/20"><div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: uploadState.percent + "%" }} /></div><p className="mt-2 text-sm font-bold text-emerald-200">{uploadState.label}</p></div>}<div className="mt-5 max-h-56 overflow-auto rounded-[1.5rem] bg-white/10 p-4 text-sm">{batches.length === 0 ? <p className="text-white/50">No uploads yet.</p> : batches.map((b) => <p key={b.uploadedAt} className="border-b border-white/10 py-3"><b>{b.fileName}</b> | {b.from || "?"} to {b.to || "?"} | total {b.total}</p>)}</div></section>}

      {activePage === "help" && <section className="grid gap-5 lg:grid-cols-3"><div className="rounded-[2.5rem] bg-white p-6 shadow-xl"><h3 className="text-xl font-black">Dispensed Copy</h3><p className="mt-2 text-sm leading-6 text-slate-600">Use this for FRED labels, repeat authorisations, patient copies, or anything that represents what was already dispensed.</p></div><div className="rounded-[2.5rem] bg-white p-6 shadow-xl"><h3 className="text-xl font-black">Original Script</h3><p className="mt-2 text-sm leading-6 text-slate-600">Use only when the actual original paper prescription arrives. The app matches by patient/identifier, medicine and date.</p></div><div className="rounded-[2.5rem] bg-white p-6 shadow-xl"><h3 className="text-xl font-black">Safety rule</h3><p className="mt-2 text-sm leading-6 text-slate-600">Low confidence or unmatched items stay in the vault for manual review instead of being forced into a match.</p></div></section>}
    </section>
  </main>;`;

page = page.slice(0, start) + replacement + page.slice(end + '</main>;'.length);
fs.writeFileSync(path, page);
console.log('Landing-style UI applied to app/page.tsx');
