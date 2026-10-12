// Zero-dependency server: aggregates recent T'au Empire results from Best Coast Pairings.
const http = require('http'), fs = require('fs'), path = require('path');
const API = 'https://newprod-api.bestcoastpairings.com/v1';
const HDR = { 'User-Agent': 'Mozilla/5.0', Origin: 'https://www.bestcoastpairings.com', 'client-id': 'web-app' };
const TTL = 15 * 60 * 1000;
let cache = {};

const get = async (p) => { const r = await fetch(API + p, { headers: HDR }); if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); };
const iso = (d) => d.toISOString().slice(0, 10);

async function load(days) {
  const end = new Date(), start = new Date(Date.now() - days * 864e5);
  let events = [], key = '';
  for (let i = 0; i < 8; i++) {
    const d = await get(`/events?limit=100&sortKey=eventDate&sortAscending=false&gameType=1&ended=true&startDate=${iso(start)}&endDate=${iso(end)}${key}`);
    events = events.concat(d.data);
    if (!d.nextKey) break;
    key = '&nextKey=' + encodeURIComponent(d.nextKey);
  }
  events = events.filter((e) => !e.hideLists && !/QA|test/i.test(e.name) && (e.totalPlayers || e.numTickets || 0) >= 1);
  const out = [];
  for (let i = 0; i < events.length; i += 8) {
    await Promise.all(events.slice(i, i + 8).map(async (e) => {
      try {
        const d = await get(`/events/${e.id}/players?limit=200&placings=true`);
        const total = d.active.length;
        for (const p of d.active) {
          if (p.faction?.name !== "T'au Empire" || !p.listId) continue;
          const wins = p.total_metrics?.find((m) => m.name === 'Wins')?.value;
          out.push({
            player: `${p.user?.firstName || ''} ${(p.user?.lastName || '')[0] || ''}.`.trim(),
            placing: p.placing, players: total, wins, games: p.total_games?.length || 0,
            detachment: p.subFaction?.name || '', event: e.name, eventId: e.id,
            date: e.eventDate, location: e.formatted_address || e.country || '',
            listUrl: `https://www.bestcoastpairings.com/list/${p.listId}`,
            eventUrl: `https://www.bestcoastpairings.com/event/${e.id}`,
          });
        }
      } catch (err) { console.error(err.message); }
    }));
  }
  return out.sort((a, b) => new Date(b.date) - new Date(a.date) || (a.placing || 999) - (b.placing || 999));
}


// --- Listhammer: parse the (allowed) server-rendered T'au faction page for detachment data ---
const LH = 'https://listhammer.info';
const dec = (t) => t.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const strip = (t) => dec(t.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, '')).trim();
async function loadListhammer() {
  const r = await fetch(LH + '/factions/tau-empire', { headers: { 'User-Agent': 'tau-lists-tracker (personal project)' } });
  if (!r.ok) throw new Error('listhammer ' + r.status);
  const html = await r.text();
  // list text lives in the page's own serialized payload (devalue format: values are indexes into one array)
  const texts = {};
  try {
    const d = JSON.parse(html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)<\/script>/s)[1]);
    for (const o of d) if (o && typeof o === 'object' && !Array.isArray(o) && 'playerUid' in o && 'listText' in o) {
      const uid = d[o.playerUid], txt = d[o.listText];
      if (typeof txt === 'string') texts[uid + '|' + d[o.eventName]] = txt;
    }
  } catch (e) { console.error('payload parse', e.message); }
  const body = html.slice(html.indexOf('Recent undefeated'));
  const out = [];
  for (const row of body.split(/<tr class="p-row-/).slice(1)) {
    const pl = row.match(/<a href="(\/players\/[^"]+)" class="app-link">([^<]+)<\/a>/);
    const ev = row.match(/<a href="(\/events\/[^"]+)" class="block group">.*?title="([^"]*)".*?\((\d+) players\)/s);
    if (!pl || !ev) continue;
    const tags = [...row.matchAll(/<span class="block text-sm text-muted-color">(.*?)<\/span>/g)].map((m) => strip(m[1])).filter(Boolean);
    const cells = [...row.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) => strip(m[1]));
    const record = (row.match(/whitespace-nowrap">([^<]+)</) || [])[1];
    out.push({
      player: strip(pl[2]), playerUrl: LH + pl[1], event: dec(ev[2]), eventUrl: LH + ev[1], players: +ev[3],
      detachments: tags.slice(0, -1), disposition: tags[tags.length - 1] || '',
      listText: texts[pl[1].split('/').pop() + '|' + dec(ev[2])] || '',
      date: cells.find((c) => /^[A-Z][a-z]{2} \d{1,2}$/.test(c)) || '', record: record ? record.replace(/\s/g, '') : '',
    });
  }
  return out;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/listhammer') {
    try {
      if (!cache.lh || Date.now() - cache.lh.t > 30 * 60 * 1000) cache.lh = { t: Date.now(), data: await loadListhammer() };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ updated: cache.lh.t, lists: cache.lh.data }));
    } catch (e) { res.writeHead(502); return res.end(JSON.stringify({ error: e.message })); }
  }
  if (u.pathname === '/api/tau') {
    const days = Math.min(+u.searchParams.get('days') || 14, 60);
    try {
      const c = cache[days];
      if (!c || Date.now() - c.t > TTL) cache[days] = { t: Date.now(), data: await load(days) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ updated: cache[days].t, lists: cache[days].data }));
    } catch (e) { res.writeHead(502); return res.end(JSON.stringify({ error: e.message })); }
  }
  const f = path.join(__dirname, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(f, (err, buf) => { if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'text/plain' }); res.end(buf); });
}).listen(process.env.PORT || 3000, () => console.log('http://localhost:' + (process.env.PORT || 3000)));
