import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createAuthenticatedClient, isPendingGrant, isFinalizedGrant } from '@interledger/open-payments';

const { OP_WALLET_ADDRESS, OP_KEY_ID, OP_PRIVATE_KEY_PATH, PORT = 3001 } = process.env;
const BASE = `http://localhost:${PORT}`;
const DB = './db.json';
let db = fs.existsSync(DB)
  ? JSON.parse(fs.readFileSync(DB, 'utf8'))
  : { recipients: [], ledger: [], grant: null, pending: null, nid: 1, asset: null };
const save = () => fs.writeFileSync(DB, JSON.stringify(db, null, 2));

const client = await createAuthenticatedClient({
  walletAddressUrl: OP_WALLET_ADDRESS,
  privateKey: OP_PRIVATE_KEY_PATH,
  keyId: OP_KEY_ID,
});

const toMinor = (v, scale) => String(Math.round(Number(v) * 10 ** scale));
const fromMinor = (v, scale) => Number(v) / 10 ** scale;
const getSender = () => client.walletAddress.get({ url: OP_WALLET_ADDRESS });

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/api/state', (_req, res) =>
  res.json({ recipients: db.recipients, ledger: db.ledger.slice(0, 100), granted: !!db.grant?.active, limit: db.grant?.limit ?? null, asset: db.asset })
);

app.post('/api/recipients', (req, res) => {
  const { n, w, a, c } = req.body;
  if (!n || !w || !(Number(a) > 0)) return res.status(400).json({ error: 'name, wallet and amount required' });
  db.recipients.push({ id: db.nid++, n, w: w.replace(/^\$/, 'https://'), a: Number(a), c: c || 'Other' });
  save();
  res.json({ ok: true });
});

app.delete('/api/recipients/:id', (req, res) => {
  db.recipients = db.recipients.filter((r) => r.id !== Number(req.params.id));
  save();
  res.json({ ok: true });
});

// Step 1: ask the payer's wallet for a monthly spending grant (user must approve it there)
app.post('/api/grant/start', async (req, res) => {
  try {
    const s = await getSender();
    const limit = Number(req.body.limit);
    if (!(limit > 0)) throw new Error('Enter a monthly limit');
    const nonce = crypto.randomUUID();
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const interval = `R12/${start.toISOString().replace('.000Z', 'Z')}/P1M`;
    const grant = await client.grant.request(
      { url: s.authServer },
      {
        access_token: {
          access: [{
            type: 'outgoing-payment',
            actions: ['read', 'create'],
            identifier: s.id,
            limits: { debitAmount: { value: toMinor(limit, s.assetScale), assetCode: s.assetCode, assetScale: s.assetScale }, interval },
          }],
        },
        interact: { start: ['redirect'], finish: { method: 'redirect', uri: `${BASE}/callback`, nonce } },
      }
    );
    if (!isPendingGrant(grant)) throw new Error('Wallet did not return an interactive grant');
    db.pending = { uri: grant.continue.uri, token: grant.continue.access_token.value, limit };
    db.asset = { code: s.assetCode, scale: s.assetScale };
    save();
    res.json({ redirect: grant.interact.redirect });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Step 2: the wallet sends the user back here after they approve
app.get('/callback', async (req, res) => {
  try {
    const { interact_ref } = req.query;
    if (!interact_ref || !db.pending) return res.redirect('/?grant=denied');
    const grant = await client.grant.continue(
      { url: db.pending.uri, accessToken: db.pending.token },
      { interact_ref }
    );
    if (!isFinalizedGrant(grant)) throw new Error('Grant not finalized');
    db.grant = { token: grant.access_token.value, manage: grant.access_token.manage, limit: db.pending.limit, active: true };
    db.pending = null;
    save();
    res.redirect('/?grant=ok');
  } catch (e) {
    res.redirect('/?grant=error&msg=' + encodeURIComponent(e.message));
  }
});

app.post('/api/grant/revoke', async (_req, res) => {
  try {
    if (db.grant?.manage) await client.token.revoke({ url: db.grant.manage, accessToken: db.grant.token });
  } catch (e) { /* token may already be invalid */ }
  db.grant = null;
  save();
  res.json({ ok: true });
});

// One payment = incoming payment (recipient) -> quote (payer) -> outgoing payment (payer, using the grant)
async function pay(r, s) {
  const rw = await client.walletAddress.get({ url: r.w });
  const ig = await client.grant.request({ url: rw.authServer }, { access_token: { access: [{ type: 'incoming-payment', actions: ['read', 'create'] }] } });
  const ip = await client.incomingPayment.create(
    { url: rw.resourceServer, accessToken: ig.access_token.value },
    { walletAddress: rw.id, incomingAmount: { value: toMinor(r.a, rw.assetScale), assetCode: rw.assetCode, assetScale: rw.assetScale } }
  );
  const qg = await client.grant.request({ url: s.authServer }, { access_token: { access: [{ type: 'quote', actions: ['create', 'read'] }] } });
  const q = await client.quote.create(
    { url: s.resourceServer, accessToken: qg.access_token.value },
    { walletAddress: s.id, receiver: ip.id, method: 'ilp' }
  );
  const op = await client.outgoingPayment.create(
    { url: s.resourceServer, accessToken: db.grant.token },
    { walletAddress: s.id, quoteId: q.id }
  );
  return { paymentId: op.id, debit: fromMinor(q.debitAmount.value, s.assetScale) };
}

app.post('/api/run', async (_req, res) => {
  const month = new Date().toISOString().slice(0, 7);
  const s = await getSender();
  const results = [];
  for (const r of db.recipients) {
    if (db.ledger.some((l) => l.month === month && l.rid === r.id && l.st === 'Paid')) continue;
    const entry = { month, rid: r.id, n: r.n, c: r.c, a: r.a, ts: new Date().toISOString() };
    if (!db.grant?.active) {
      Object.assign(entry, { st: 'Blocked', why: 'No active grant', debit: 0 });
    } else {
      try {
        const out = await pay(r, s);
        Object.assign(entry, { st: 'Paid', why: '', debit: out.debit, paymentId: out.paymentId });
      } catch (e) {
        Object.assign(entry, { st: 'Failed', why: String(e.message).slice(0, 120), debit: 0 });
      }
    }
    db.ledger.unshift(entry);
    results.push(entry);
  }
  save();
  res.json({ results });
});

app.listen(PORT, () => console.log(`TrakFin running at ${BASE}`));
