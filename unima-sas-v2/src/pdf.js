// PDF export helpers (results + voter list). Uses pdfkit with built-in standard fonts.
const PDFDocument = require('pdfkit');

function streamResponse(res, filename, fn) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const doc = new PDFDocument({ margin: 48, size: 'A4' });
  doc.on('error', (err) => { console.error('[pdf]', err); if (!res.writableEnded) res.destroy(err); });
  fn(doc);
  doc.end();
}

function wrap(doc, text, x, y, w, opts = {}) {
  const lines = doc.text(text, x, y, { width: w, ...opts });
  return doc.y + 4;
}

function header(doc, election) {
  doc.font('Helvetica-Bold').fontSize(18).text(election.name, { underline: true });
  doc.font('Helvetica').fontSize(10).text(`Election slug: ${election.slug} · Exported ${new Date().toISOString().slice(0, 16)}`);
  if (election.description) {
    doc.fontSize(10).text(election.description, { width: 456 });
  }
  doc.moveDown(1);
}

function drawCandidate(doc, c, x, y, w) {
  // Try to embed the photo; fall back to the URL text if it can't be fetched.
  let used = false;
  if (c.photo_url) {
    try {
      doc.image(c.photo_url, x, y, { width: 48, height: 48 });
      used = true;
    } catch (_) { /* fall through to text */ }
  }
  doc.font('Helvetica-Bold').fontSize(11).text(c.name, x + (used ? 56 : 0), y, { width: w - (used ? 56 : 0) });
  if (!used && c.photo_url) {
    doc.font('Helvetica').fontSize(8).text(`Photo: ${c.photo_url}`, x, y + 16, { width: w, color: '#6b7280' });
  }
  return y + 60;
}

module.exports = {
  resultsPdf: (res, election, results) => streamResponse(res, `${election.slug}-results.pdf`, (doc) => {
    header(doc, election);
    results.positions.forEach((p) => {
      doc.font('Helvetica-Bold').fontSize(13).text(p.title, { underline: true });
      doc.moveDown(0.4);
      p.slots.forEach((s) => {
        if (s.group_label) {
          doc.font('Helvetica-BoldOblique').fontSize(11).text(`Group: ${s.group_label}`);
          doc.font('Helvetica').fontSize(10);
        }
        if (!s.candidates.length) { doc.font('Helvetica').fontSize(10).text('No candidates.'); doc.moveDown(0.5); return; }
        const max = Math.max(1, ...s.candidates.map((c) => c.votes));
        const top = s.candidates[0].votes > 0 ? s.candidates[0].votes : null;
        s.candidates.forEach((c, i) => {
          const win = top !== null && c.votes === top;
          const y = doc.y;
          doc.font(win ? 'Helvetica-Bold' : 'Helvetica').fontSize(10)
            .text(`${i + 1}. ${c.name}`, 48, y, { width: 200 });
          doc.font('Helvetica').fontSize(10).text(`${c.votes} vote${c.votes === 1 ? '' : 's'}`, 256, y, { width: 80 });
          doc.font('Helvetica').fontSize(9).text(win ? 'Winner 🏆' : 'Loser 🚲', 340, y + 2, { width: 100 });
          const barW = Math.round((c.votes / max) * 150);
          doc.rect(48, y + 14, barW, 6).fill(win ? '#c9a84c' : '#1a3a5c');
          doc.moveDown(1.2);
        });
        doc.moveDown(0.6);
      });
      doc.moveDown(0.8);
    });
    doc.font('Helvetica').fontSize(9).text(`Total ballots: ${results.total_ballots}`);
  }),

  votersPdf: (res, election, voters) => streamResponse(res, `${election.slug}-voters.pdf`, (doc) => {
    header(doc, election);
    const counts = { all: voters.length, approved: 0, pending: 0, rejected: 0, voted: 0 };
    voters.forEach((v) => { counts[v.status]++; if (v.has_voted) counts.voted++; });
    doc.font('Helvetica-Bold').fontSize(11).text(`Registered: ${counts.all} · Approved: ${counts.approved} · Pending: ${counts.pending} · Rejected: ${counts.rejected} · Have voted: ${counts.voted}`);
    doc.moveDown(1);
    const headers = ['Reg number', 'Status', 'Voted', 'Registered at'];
    const xs = [48, 240, 320, 380];
    doc.font('Helvetica-Bold').fontSize(9);
    headers.forEach((h, i) => doc.text(h, xs[i], doc.y));
    doc.moveDown(0.6);
    doc.font('Helvetica').fontSize(9);
    voters.forEach((v) => {
      const y = doc.y;
      doc.text(v.reg_number, xs[0], y, { width: 180 });
      doc.text(v.status, xs[1], y, { width: 70 });
      doc.text(v.has_voted ? 'Yes' : 'No', xs[2], y, { width: 60 });
      doc.text(new Date(v.created_at).toISOString().slice(0, 16), xs[3], y, { width: 120 });
      doc.moveDown(0.55);
    });
  }),

  // The candidate ballot: one page per position, grouped like the on-screen ballot.
  candidatesPdf: (res, election, { groups, positions, candidates }) => streamResponse(res, `${election.slug}-candidates.pdf`, (doc) => {
    header(doc, election);
    doc.font('Helvetica-Bold').fontSize(11).text(`Candidates: ${candidates.length} · Positions: ${positions.length} · Groups: ${groups.length || 'none'}`);
    doc.moveDown(1);
    const slotGroups = groups.length ? groups : [{ id: null, label: null }];
    positions.forEach((p) => {
      doc.font('Helvetica-Bold').fontSize(13).text(p.title, { underline: true });
      doc.moveDown(0.5);
      slotGroups.forEach((g) => {
        const cs = candidates.filter((c) => c.position_id === p.id && (c.group_id ?? null) === g.id);
        if (g.label) {
          doc.font('Helvetica-BoldOblique').fontSize(11).text(`Group: ${g.label}`);
          doc.font('Helvetica').fontSize(10);
        }
        if (!cs.length) { doc.font('Helvetica').fontSize(10).text('No candidates listed.'); doc.moveDown(0.5); return; }
        let y = doc.y;
        cs.forEach((c) => {
          y = drawCandidate(doc, c, 48, y, 456);
          if (y > 740) { doc.addPage(); y = 48; }
        });
        doc.moveDown(0.8);
      });
      if (doc.y > 740) doc.addPage();
      doc.moveDown(0.6);
    });
  }),
};