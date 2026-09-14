/**
 * THE REALITY FOOTBALL LEAGUE BACK END.
 *
 * WHAT THIS REPLACES AND WHY. Until 13 Sep 2026 this job was done by a Google Sheet and an Apps
 * Script bound to it. Google disabled the account that owned them, with no warning and no way
 * back except an appeal: a Gmail account a few days old, signed in from several devices,
 * publishing a web app open to anyone and sending automated mail, is the exact profile their
 * new-account abuse system fires on. Casey, 13 Sep 2026, after reading the ban notice: "I think
 * we need to move forward with another option today."
 *
 * SO THE STORE MOVED SOMEWHERE THIS BELONGS. A Cloudflare Worker with a KV namespace behind it
 * is the same shape as the script was -- one address, one doorman, a small amount of state --
 * without being a document living in somebody's personal Drive.
 *
 * IT IS NAMED FOR THE LEAGUE, NOT FOR TRADES. Casey, 13 Sep 2026: "this also grants access to
 * the entire dashboard and what their teams are ... it is really RFL overall." Identity, what
 * each owner is allowed to see, their roster, and trades are all one thing here.
 *
 * THE CONTRACT IS THE SAME ONE THE PAGE ALREADY SPEAKS, so the trades application did not have
 * to be rewritten: ping, public, redeem, me, view, submit, load, save. Three are new, and they
 * exist because email is gone: `codes` hands the commissioner each owner's sign-in code, `retire`
 * issues a fresh one, and `setup` seeds the seats the first time.
 *
 * NO EMAIL, ON PURPOSE. Casey, 13 Sep 2026: "could we just direct them to a page on the dashboard
 * that shows the results and they just have to go into the dashboard to see it?" Yes, and it
 * removes the part that got the last account killed. The commissioner hands each owner their
 * code once, and what happened on Monday is read on the dashboard. Sending to 27 strangers needs
 * a domain this league does not have yet, and a code delivered by the commissioner is the same
 * secret an email would have carried.
 *
 * EVERY WRITE NAMES THE VERSION IT IS REPLACING. Two commissioners working at once is a real
 * case -- Casey and Bob, on a Monday afternoon -- and the loser of the race must be told rather
 * than silently overwritten. That is `rev`, and it works exactly as it did on the sheet.
 */

const KEY_LEN = 40;
const CODE_LEN = 6;
/* NO I, O, 0 OR 1. These codes are read off a screen and typed on a phone by 27 people, some of
   whom are reading them out over the phone to somebody else. */
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ---------- the small amount of plumbing ------------------------------------------------- */

/* TEXT/PLAIN ON PURPOSE. Any other content type makes the browser ask permission first with a
   preflight request, and that is one more thing to get wrong. Inherited from the Apps Script
   version, where it was the difference between working and not. */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function out(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

function rand(n, abc) {
  const pool = abc || 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < n; i++) s += pool[b[i] % pool.length];
  return s;
}

/* A TYPED CODE IS READ FORGIVINGLY. Somebody will type it in lower case, or paste it with a
   space in the middle, and refusing that teaches them nothing. */
function tidyCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function getJSON(env, k, dflt) {
  const v = await env.RFL.get(k, 'json');
  return v == null ? dflt : v;
}
const putJSON = (env, k, v) => env.RFL.put(k, JSON.stringify(v));

/* ---------- who is asking ---------------------------------------------------------------- */

/* A SEAT HOLDS PEOPLE, AND THE ROLE BELONGS TO THE PERSON.
 *
 * Casey, 13 Sep 2026: "it's important because I share that seat with Dominic. Will we have the
 * same code and then he's inherently a commissioner? We wouldn't want that to be the case."
 * He was right, and the first version had this wrong. One code per SEAT meant Casey's
 * commissioner powers came with the seat, so his co-owner would have had them too.
 *
 * So a seat has MEMBERS. Each one has their own code and their own role. Casey and Dominic
 * share the Palma/Wiedeman roster, see the same teams, and can both enter that seat's trades.
 * Only Casey's code opens the commissioner half. Several seats here are two people, so this is
 * the normal case and not a special one.
 *
 * A PERSON IS IDENTIFIED BY AN EMAIL ADDRESS, NOT A NAME. Casey, 14 Sep 2026: "I don't
 * necessarily know the names of all each and every owner", and he does hold every address. A
 * name he would have to invent is a name that will be wrong; the address is the thing he
 * actually has.
 *
 * BUT THE ID IS NOT THE ADDRESS. Every member carries a short `id` that never changes. The
 * address is an attribute hanging off it. Correcting somebody's address must not sign them out
 * of every device they own, and it would if the address were the identity.
 *
 * THE ADDRESSES ARE THE ONE PRIVATE THING IN HERE. `view`, which every owner calls, returns no
 * address and no member list at all -- only how many devices a seat has signed in. Only the
 * commissioner half ever sees who is on a seat.
 */
function membersOf(seat) {
  /* A SEAT WRITTEN BEFORE MEMBERS EXISTED READS AS ONE MEMBER. Nobody is signed out by the
     upgrade and no code changes. */
  if (seat.members && seat.members.length) return seat.members;
  return [{ id: 'm1', email: seat.email || '', label: '', code: seat.code,
            role: seat.role || 'owner', retiredSeq: seat.retiredSeq || 0 }];
}

/* HOW A PERSON IS NAMED BACK TO A HUMAN READER, on the Access List and nowhere else. */
const memberLabel = (m) => m.label || m.email || m.id;

async function whois(env, given) {
  const key = String(given || '').trim();
  if (!key) return null;
  const keys = await getJSON(env, 'keys', {});
  const row = keys[key];
  if (!row) return null;
  const access = await getJSON(env, 'access', []);
  const seat = access.find((a) => a.div === row.div && a.seat === row.seat);
  if (!seat) return { dead: 'that seat is no longer on the access list' };
  if (seat.status === 'inactive' || seat.status === 'removed') {
    return { dead: 'that seat has been made inactive' };
  }
  const me = membersOf(seat).find((m) => m.id === row.member);
  if (!me) return { dead: 'that person is no longer on that seat' };
  /* A KEY ISSUED BEFORE THAT PERSON WAS LAST RETIRED IS DEAD. Counted per person, so retiring
     one co-owner does not sign the other out of the same seat. */
  if ((me.retiredSeq || 0) > (row.seq || 0)) {
    return { dead: 'the sign-ins for that person were retired' };
  }
  return { key, div: row.div, seat: row.seat, member: me.id,
           role: me.role || 'owner', email: me.email || '' };
}

const isCommish = (who) => !!(who && !who.dead && who.role === 'commissioner');
/* AT LEAST ONE COMMISSIONER MUST SURVIVE ANY CHANGE, anywhere in the league, on any seat. */
const anyCommish = (access) =>
  access.some((a) => a.status !== 'inactive' && membersOf(a).some((m) => m.role === 'commissioner'));

/* ---------- the state, and the safe write ------------------------------------------------ */

async function readState(env) {
  const box = await getJSON(env, 'state', { rev: 0, state: null });
  return box;
}

async function writeState(env, state, rev) {
  await putJSON(env, 'state', { rev, state, at: new Date().toISOString() });
}

/* WHAT EVERY OWNER MAY SEE, BUILT SMALLER RATHER THAN HIDDEN.
 * A field that is merely hidden is still in the answer for anyone who looks, which is the same
 * mistake the league dashboard's own filter exists to avoid. So this constructs what is public
 * instead of removing what is not.
 */
function publicOf(box) {
  const s = (box && box.state) || {};
  const tx = [];
  for (const t of s.log || []) {
    if (!t || t['in'] == null) continue;
    tx.push({
      week: t.week == null ? null : t.week,
      div: t.div || '', owner: t.owner || '',
      in: t['in'], out: t.out || '', how: t.how || '',
      contested: !!t.contested, effective: t.effective || null,
      fee: typeof t.fee === 'number' ? t.fee : null,
      fee_note: t.fee_note || '',
    });
  }
  return { ok: true, rev: box.rev, at: new Date().toISOString(),
           transactions: tx, rosters: s.rosters || null };
}

/* ---------- the handlers ------------------------------------------------------------------ */

async function handle(request, env) {
  const url = new URL(request.url);
  let body = {};
  if (request.method === 'POST') {
    try { body = JSON.parse(await request.text()) || {}; } catch (e) { body = {}; }
  }
  const p = (n) => body[n] != null ? body[n] : url.searchParams.get(n);
  const fn = p('fn') || 'load';
  const given = p('key') || '';

  /* OPEN TO ANYBODY, ON PURPOSE. `ping` says the back end is alive. `public` is what the two
     dashboards read and carries nothing private. `redeem` is how a person gets a key in the
     first place, so it cannot need one. */
  if (fn === 'ping') {
    const access = await getJSON(env, 'access', []);
    const box = await readState(env);
    return out({ ok: true, at: new Date().toISOString(), seats: access.length,
                 ready: !!box.state, rev: box.rev, store: 'cloudflare' });
  }

  if (fn === 'public') return out(publicOf(await readState(env)));

  /* SEEDING THE SEATS. Done once, by somebody holding the setup word that lives in this Worker's
     own settings and nowhere else. It creates the 27 access records and a code for each. */
  if (fn === 'setup') {
    if (!env.ADMIN || String(p('admin') || '') !== env.ADMIN) {
      return out({ ok: false, why: 'admin', note: 'that is not the setup word' });
    }
    const seats = p('seats') || [];
    if (!seats.length) return out({ ok: false, why: 'empty', note: 'no seats were sent' });
    const existing = await getJSON(env, 'access', []);
    const byKey = {};
    for (const a of existing) byKey[a.div + '|' + a.seat] = a;
    const access = seats.map((s) => {
      const had = byKey[s.div + '|' + s.owner];
      /* AN EXISTING SEAT KEEPS ITS PEOPLE, THEIR CODES AND THEIR ROLES. Re-running setup must
         never sign the league out or quietly demote a commissioner. */
      if (had) return { ...had, members: membersOf(had) };
      /* A SEAT SEEDED WITH NO ADDRESSES STILL GETS ONE MEMBER AND ONE CODE. The addresses can
         be filled in later without anybody signing in again, because the id is what the key
         points at. */
      const people = (s.members && s.members.length) ? s.members : [{ email: '' }];
      return { div: s.div, seat: s.owner, status: 'active',
               members: people.map((x, i) => ({ id: 'm' + (i + 1),
                 email: String((x && x.email) || ''), label: String((x && x.label) || ''),
                 code: rand(CODE_LEN, CODE_ABC), role: 'owner', retiredSeq: 0 })) };
    });
    /* THE FIRST COMMISSIONERS. Without one, the Access List -- the only place a role can be
       changed -- belongs to nobody, which is a locked room with the key inside it.
       Naming a person is optional; without one the seat's first member gets it. */
    const firsts = p('commissioners') || (p('commissioner') ? [p('commissioner')] : []);
    for (const f of firsts) {
      const seat = access.find((a) => a.div === f.div && a.seat === f.owner);
      if (!seat) continue;
      const want = f.member || f.email;
      const m = want ? seat.members.find((x) => x.id === want || (x.email && x.email === want))
                     : seat.members[0];
      if (m) m.role = 'commissioner';
    }
    await putJSON(env, 'access', access);
    return out({ ok: true, seats: access.length,
                 codes: access.flatMap((a) => a.members.map((m) => ({ div: a.div, seat: a.seat,
                        member: m.id, who: memberLabel(m), code: m.code, role: m.role }))) });
  }

  /* SIGNING IN. The owner types the code their commissioner gave them and this device gets a key
     of its own. The code keeps working, because one person signs in on a phone AND a laptop and
     making the second one need a fresh code is a support call nobody needs. */
  if (fn === 'redeem') {
    const code = tidyCode(p('t'));
    if (code.length !== CODE_LEN) {
      return out({ ok: false, why: 'bad', note: 'a sign-in code is six letters and numbers' });
    }
    const access = await getJSON(env, 'access', []);
    let seat = null, me = null;
    for (const a of access) {
      const hit = membersOf(a).find((m) => tidyCode(m.code) === code);
      if (hit) { seat = a; me = hit; break; }
    }
    /* THE SAME ANSWER FOR A WRONG CODE AND A CODE ON A SEAT THAT IS TURNED OFF. Telling the two
       apart would let somebody work out which codes exist. */
    if (!seat || seat.status === 'inactive' || seat.status === 'removed') {
      return out({ ok: false, why: 'nocode',
                   note: 'that code is not one this league issued. Check it with the commissioner.' });
    }
    const keys = await getJSON(env, 'keys', {});
    const old = String(p('old') || '').trim();
    /* THE KEY THIS BROWSER IS REPLACING GOES AWAY. A browser holds one key, so signing in again
       on a phone that was already signed in used to leave the old one behind where nothing could
       use it, and the signed-in count went up by one every time. It is dropped only if it belongs
       to this same person, so Casey signing in cannot knock Dominic off the shared seat. */
    if (old && keys[old] && keys[old].div === seat.div && keys[old].seat === seat.seat
        && keys[old].member === me.id) {
      delete keys[old];
    }
    const key = rand(KEY_LEN);
    keys[key] = { div: seat.div, seat: seat.seat, member: me.id, seq: me.retiredSeq || 0,
                  issued: new Date().toISOString(), lastSeen: new Date().toISOString() };
    await putJSON(env, 'keys', keys);
    /* THE PAGE IS TOLD THE SEAT, BECAUSE THE SEAT IS WHAT IT SHOWS. */
    return out({ ok: true, key, div: seat.div, seat: seat.seat, role: me.role || 'owner' });
  }

  /* Everything past here needs a key. */
  const who = await whois(env, given);
  if (!who) {
    return out({ ok: false, why: 'nokey',
                 note: 'this device has not signed in. Ask the commissioner for your code.' });
  }
  if (who.dead) return out({ ok: false, why: 'dead', note: who.dead });

  if (fn === 'me') return out({ ok: true, me: { div: who.div, seat: who.seat,
                                email: who.email, role: who.role } });

  if (fn === 'view') {
    const box = await readState(env);
    const s = box.state || {};
    const access = await getJSON(env, 'access', []);
    const keys = await getJSON(env, 'keys', {});
    const counts = {};
    for (const k of Object.keys(keys)) {
      const r = keys[k];
      counts[r.div + '|' + r.seat] = (counts[r.div + '|' + r.seat] || 0) + 1;
    }
    const mine = who.div + '|' + who.seat;
    const reqs = s.requests || {};
    return out({
      ok: true, rev: box.rev, at: new Date().toISOString(),
      me: { div: who.div, seat: who.seat, email: who.email, role: who.role },
      /* THE SEATS ARE NOT SECRET -- every owner sees the standings. The ADDRESSES are, so this
         is rebuilt with only what a roster needs. */
      seats: access.map((a) => ({ div: a.div, seat: a.seat, status: a.status,
                                  signedIn: counts[a.div + '|' + a.seat] || 0 })),
      rosters: s.rosters || null,
      acquiredAt: s.acquiredAt || {},
      mine: reqs[mine] || null,
      /* HOW MANY OTHERS ARE IN, AND NOT WHO OR FOR WHAT. Knowing which team somebody else asked
         for would let an owner steer their own list. */
      othersWaiting: Math.max(0, Object.keys(reqs).length - (reqs[mine] ? 1 : 0)),
      transactions: publicOf(box).transactions,
      results: s.results || null,
      ranWeeks: s.ranWeeks || {},
    });
  }

  /* AN OWNER WRITES THEIR OWN ROW AND NOTHING ELSE. The whole state is never handed to an owner
     to send back, because an owner who can send the whole state back can rewrite any roster. */
  if (fn === 'submit') {
    const box = await readState(env);
    const s = box.state;
    if (!s) return out({ ok: false, why: 'empty',
                         note: 'the league has not been set up in the trades page yet' });
    const mine = who.div + '|' + who.seat;
    s.requests = s.requests || {};
    if (p('clear')) {
      delete s.requests[mine];
    } else {
      const rows = p('rows');
      if (!rows || !rows.length) return out({ ok: false, why: 'empty',
                                              note: 'there was nothing to send' });
      /* THE SEAT SENT IT, NOT A PERSON. Casey, 14 Sep 2026: "I don't think we'd want the
         trade recorded as the person that did the trade. It should still show the team that did
         the trade, not the individual person." Two co-owners are one owner as far as the league
         is concerned. The person who typed it is not recorded -- not shown, and not held quietly
         in the record either, because a field that exists gets displayed eventually. */
      s.requests[mine] = { div: who.div, seat: who.seat, rows,
                           submitted: new Date().toISOString(), by: who.seat };
    }
    const rev = box.rev + 1;
    await writeState(env, s, rev);
    return out({ ok: true, rev, mine: s.requests[mine] || null });
  }

  /* ---------- the commissioner's half ---------------------------------------------------- */
  if (!isCommish(who)) {
    return out({ ok: false, why: 'notyours',
                 note: 'that part of the page belongs to the commissioner' });
  }

  if (fn === 'codes') {
    const access = await getJSON(env, 'access', []);
    return out({ ok: true, codes: access.flatMap((a) => membersOf(a).map((m) => ({
      div: a.div, seat: a.seat, member: m.id, email: m.email || '', who: memberLabel(m),
      code: m.code, role: m.role || 'owner', status: a.status }))) });
  }

  /* RETIRING A SEAT TURNS AWAY EVERY DEVICE ON IT AND ISSUES A FRESH CODE. One button, because
     the two always go together: a code somebody else has seen is exactly when you want the old
     devices gone, and a lost phone is exactly when you want a new code. */
  if (fn === 'retire') {
    const access = await getJSON(env, 'access', []);
    const seat = access.find((a) => a.div === p('div') && a.seat === p('seat'));
    if (!seat) return out({ ok: false, why: 'noseat', note: 'no seat by that name' });
    seat.members = membersOf(seat);
    const only = p('member') || p('email');
    const hit = only ? seat.members.filter((m) => m.id === only || m.email === only)
                     : seat.members;
    if (only && !hit.length) {
      return out({ ok: false, why: 'noperson', note: 'nobody by that name is on that seat' });
    }
    for (const m of hit) {
      m.retiredSeq = (m.retiredSeq || 0) + 1;
      m.code = rand(CODE_LEN, CODE_ABC);
    }
    const ids = hit.map((m) => m.id);
    const keys = await getJSON(env, 'keys', {});
    let gone = 0;
    for (const k of Object.keys(keys)) {
      const r = keys[k];
      if (r.div === seat.div && r.seat === seat.seat && ids.indexOf(r.member) >= 0) {
        delete keys[k]; gone++;
      }
    }
    /* RETIRING THE LAST COMMISSIONER'S SIGN-IN IS FINE -- they are still the commissioner, they
       just have a new code. Only a ROLE change can empty the job, and that is checked there. */
    await putJSON(env, 'access', access);
    await putJSON(env, 'keys', keys);
    return out({ ok: true, gone,
                 codes: hit.map((m) => ({ member: m.id, who: memberLabel(m),
                                          code: m.code })) });
  }

  /* SETTING A SEAT'S ROLE OR STATUS. The Access List is where this is done now; there is no
     spreadsheet behind it to type into any more. */
  if (fn === 'seat') {
    const access = await getJSON(env, 'access', []);
    const seat = access.find((a) => a.div === p('div') && a.seat === p('seat'));
    if (!seat) return out({ ok: false, why: 'noseat', note: 'no seat by that name' });
    seat.members = membersOf(seat);
    const status = p('status');
    /* STATUS IS THE SEAT'S. A seat leaving the league takes its people with it. */
    if (status === 'active' || status === 'inactive') seat.status = status;

    /* ADDING THE SECOND PERSON TO A SEAT. Send the address; they get their own code and start
       as a plain owner. This is how a co-owner is added without touching the first one. */
    const add = p('add');
    let added = null;
    if (add) {
      const addr = String((typeof add === 'string') ? add : (add.email || '')).trim();
      if (!addr) return out({ ok: false, why: 'noaddress', note: 'that had no address on it' });
      if (seat.members.some((m) => m.email && m.email.toLowerCase() === addr.toLowerCase())) {
        return out({ ok: false, why: 'already', note: 'that address is already on that seat' });
      }
      let n = seat.members.length + 1;
      while (seat.members.some((m) => m.id === 'm' + n)) n++;
      added = { id: 'm' + n, email: addr, label: String((add && add.label) || ''),
                code: rand(CODE_LEN, CODE_ABC), role: 'owner', retiredSeq: 0 };
      seat.members.push(added);
    }

    /* ROLE AND ADDRESS BELONG TO A PERSON. Say which one by id or by their current address.
       With one person on the seat there is nothing to choose and it can be left out. */
    const role = p('role'), email = p('email'), label = p('label');
    if (role != null || email != null || label != null) {
      const want = p('member');
      const m = want ? seat.members.find((x) => x.id === want || x.email === want)
                     : (seat.members.length === 1 ? seat.members[0] : null);
      if (!m) {
        return out({ ok: false, why: 'whichperson',
                     note: 'that seat has more than one person on it, so say which one' });
      }
      if (role === 'owner' || role === 'commissioner') m.role = role;
      /* CHANGING AN ADDRESS DOES NOT SIGN ANYBODY OUT. The key points at the id, not the
         address, which is the whole reason the id exists. */
      if (email != null) m.email = String(email).trim();
      if (label != null) m.label = String(label).trim();
    }
    /* THE LAST COMMISSIONER CANNOT BE STOOD DOWN. That is the locked room again. */
    if (!anyCommish(access)) {
      return out({ ok: false, why: 'lastone',
                   note: 'that would leave the league with no commissioner' });
    }
    await putJSON(env, 'access', access);
    return out({ ok: true, added: added && { member: added.id, code: added.code },
                 members: seat.members.map((m) => ({ member: m.id, email: m.email || '',
                   who: memberLabel(m), role: m.role || 'owner', code: m.code })) });
  }

  if (fn === 'load') {
    const box = await readState(env);
    const access = await getJSON(env, 'access', []);
    const keys = await getJSON(env, 'keys', {});
    const counts = {}, perPerson = {};
    for (const k of Object.keys(keys)) {
      const r = keys[k];
      counts[r.div + '|' + r.seat] = (counts[r.div + '|' + r.seat] || 0) + 1;
      const pk = r.div + '|' + r.seat + '|' + r.member;
      perPerson[pk] = (perPerson[pk] || 0) + 1;
    }
    return out({ ok: true, rev: box.rev, state: box.state,
                 access: access.map((a) => ({ div: a.div, seat: a.seat, status: a.status,
                   members: membersOf(a).map((m) => ({ member: m.id, email: m.email || '',
                     who: memberLabel(m), role: m.role || 'owner', code: m.code,
                     signedIn: perPerson[a.div + '|' + a.seat + '|' + m.id] || 0 })) })),
                 signedIn: counts,
                 me: { div: who.div, seat: who.seat, email: who.email, role: who.role },
                 at: new Date().toISOString() });
  }

  if (fn === 'save') {
    const box = await readState(env);
    const base = p('rev') == null ? null : Number(p('rev'));
    /* THE LOSER OF A RACE IS TOLD, AND HANDED THE CURRENT COPY. Two commissioners on a Monday
       afternoon is a real case, and a silent overwrite is how one of them loses an hour. */
    if (base != null && base !== box.rev) {
      return out({ ok: false, why: 'stale', rev: box.rev, state: box.state,
                   note: 'this was written from an older copy' });
    }
    const rev = box.rev + 1;
    await writeState(env, p('state'), rev);
    return out({ ok: true, rev, at: new Date().toISOString() });
  }

  return out({ ok: false, why: 'unknown', note: 'no such request: ' + fn });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (!env.RFL) {
        return out({ ok: false, why: 'nokv',
                     note: 'this Worker has no KV namespace bound to it as RFL' });
      }
      return await handle(request, env);
    } catch (err) {
      /* AN ERROR IS AN ANSWER, NOT A BLANK PAGE. The trades page shows what came back, and
         "could not be read" with a reason beats a spinner that never stops. */
      return out({ ok: false, why: 'error', note: String((err && err.message) || err) });
    }
  },
};
