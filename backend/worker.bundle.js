/* GENERATED FILE -- DO NOT EDIT.
 * Built by code/worker/build_worker.py from three sources that are edited instead:
 *   code/peloton.js       who wins a contested team. The one resolver, shared with the page.
 *   code/board.js         the four league facts the resolver is handed. Also shared.
 *   code/worker/worker.js this back end's own handlers.
 * Editing this file means the next build silently throws your change away.
 */


/* ===== peloton.js ===== */
/* THE PELOTON RESOLVER — the one implementation, used by three things.
 *
 *   1. Owners_League_Trades_SANDBOX.html   (Casey testing scenarios against a copy)
 *   2. the Apps Script that runs for real at 4:00pm AZ Monday
 *   3. test_peloton.js
 *
 * It is deliberately PURE: no DOM, no network, no clock of its own, no randomness of its own.
 * Everything it needs arrives in its arguments and everything it decides comes back in its
 * return value. That is what lets the same file run in a browser and on Google's servers, and
 * it is what lets a suite drive it. A resolver that reads the clock cannot be tested on a
 * Monday in December.
 *
 * TWO STORES OF ONE FACT IS HOW THEY DISAGREE. If the sandbox resolved trades one way and the
 * live script another, Casey would test one system and run a different one — which is worse
 * than not testing at all, because it produces confidence rather than doubt.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Peloton = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

var MAX_ROWS  = 10;      // Casey, 9 Sep 2026: "I do think 10 rows is plenty."
var MAX_DROPS = 4;       // "four drops each ... that should be enough."

/* ---------------------------------------------------------------------------------------------
 * A COIN FLIP THAT CANNOT BE RE-RUN IS NOT AUDITABLE.
 * Math.random() gives an answer nobody can check. This is a seeded generator, so the same week,
 * the same division, the same team and the same seed always produce the same winner — Bob can
 * re-run Monday's peloton in the sandbox on Thursday and get the identical result, which is the
 * only thing that settles an argument about who won Navy.
 * mulberry32: small, fast, well-distributed, and short enough to read.
 * ------------------------------------------------------------------------------------------ */
function hash32(s){
  var h = 2166136261 >>> 0;
  for (var i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function mulberry32(a){
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* THE KEY IS WHAT THE CONTEST *IS*, NOT WHAT NUMBER IT HAPPENED TO BE.
   It was a running counter, and a counter couples contests that have nothing to do with each
   other: adding one late request for Alabama shifts the number of every contest after it and
   silently re-rolls the winner of each. Casey, 11 Sep 2026, asking about undo-and-rerun: "if he
   had to add another trade manually it wouldn't be the same answer, because you've now entered a
   new variable."  He is right that the contest he changed must be re-drawn -- and wrong only in
   the direction that matters: a contest he did NOT touch should come out the same.
   Round (the row index) plus team identifies a contest uniquely: within one round the entrants
   are grouped BY team, so a team is contested at most once. */
function flipKey(seed, week, div, team, round){
  return String(seed) + '|w' + week + '|' + div + '|' + team + '|r' + round;
}

/* --------------------------------------------------------------------------------------------
 * WHY A ROW ENDED. Every row gets exactly one of these, and every one of them is a sentence the
 * owner can act on. 'failed' with no reason is the thing this list exists to prevent.
 * ----------------------------------------------------------------------------------------- */
var OUTCOME = {
  WON:          'won',            // won a coin flip against other owners
  WON_ALONE:    'won_alone',      // nobody else asked, so no flip happened
  LOST:         'lost',           // lost the coin flip
  STOOD_ASIDE:  'stood_aside',    // had already won a flip this week, so held out of this one
  SKIPPED:      'skipped',        // its condition said not to run
  NO_DROP:      'no_drop',        // every team listed to drop was gone, held, or already used
  OWNED:        'owned',          // the team is not available in this division
  HAVE_IT:      'have_it',        // the owner already holds it
  WRONG_POOL:   'wrong_pool',     // college trades for college, NFL for NFL -- 8/3 is a rule
  JUST_DROPPED: 'just_dropped',   // dropped this week; has to play a game before it can be had
  NOT_CLAIMABLE:'not_claimable',  // too few games left to be claimed
  DUPLICATE:    'duplicate',      // an earlier row of this owner's already took this team
  INVALID:      'invalid'         // the row itself does not make sense (bad condition, no pickup)
};
var GOT = {won: 1, won_alone: 1};        // the two endings that mean "you have the team"

/* ---------------------------------------------------------------------------------------------
 * THE LEAGUE STATE the resolver is handed. Nothing is read from anywhere else.
 *   divisions : ['PFD','VFD','SFD']
 *   rosters   : {'PFD|Palma/Wiedeman': ['Navy', ...]}     -- who holds what, per division seat
 *   holdMet   : {'PFD|Palma/Wiedeman': {'Navy': true}}    -- has this team met its 3-game hold
 *   claimOK   : {'Navy': true}         -- enough games LEFT to be picked up (3). Nothing to do
 *                                         with how many it has PLAYED: a team in its first week
 *                                         is claimable, it just cannot be dropped for a while.
 *   tradeAwayOK:{'Navy': true}         -- a DIFFERENT rule with a DIFFERENT threshold: the team
 *                                         going out must still have at least one regular season
 *                                         game. A team whose season is over is stuck on the
 *                                         roster even though its hold finished months ago, so
 *                                         this cannot be folded into holdMet -- one flag with
 *                                         two meanings gives the owner the wrong reason.
 * A team that is in nobody's roster for a division is FREE in that division and only that one.
 * Casey, 9 Sep 2026: "this is division by division ... separately for another division."
 * ------------------------------------------------------------------------------------------ */
function seatKey(div, seat){ return div + '|' + seat; }

/* LIKE FOR LIKE. From the commissioner's written rules: "Only college teams may be traded for
   college teams and NFL teams for NFL teams, to sustain the 8 college teams / 3 NFL teams
   requirement." FBS and FCS are BOTH college, so the test is NFL-or-not rather than an exact
   pool match. Without this a roster silently stops being 8 and 3, which is not a trade rule so
   much as the shape of the team -- and nothing else in the system would have noticed.
   A team whose pool is unknown does not block the trade: unknown is not "wrong". */
function sameSide(league, a, b){
  var pools = league.pools || {};
  var pa = pools[a], pb = pools[b];
  if (!pa || !pb) return true;
  return (pa === 'NFL') === (pb === 'NFL');
}

function heldBy(league, div, team){
  var pre = div + '|';
  for (var k in league.rosters){
    if (k.slice(0, pre.length) !== pre) continue;
    if ((league.rosters[k] || []).indexOf(team) !== -1) return k.slice(pre.length);
  }
  return null;
}

/* WHICH EARLIER TRADES A CONDITION NAMES.
   Casey, 20 Sep 2026: "I want to do it if I miss trade one, two, or three. So if I miss any one
   of those trades, I still want to do it ... but if I get all three, I don't want to make this
   fourth trade."
   So a condition names a LIST, and it is satisfied when ANY trade on that list ended the named
   way. The old shape stored a single `row`, and lists sent before this change still carry it, so
   both are read here and nowhere else. ONE READER, OR THE PAGE AND THE SETTLE WILL DISAGREE. */
function condRows(c){
  if (!c) return [];
  if (Object.prototype.toString.call(c.rows) === '[object Array]' && c.rows.length){
    var out = [], seen = {};
    for (var i = 0; i < c.rows.length; i++){
      var n = +c.rows[i];
      if (n >= 1 && !seen[n]){ seen[n] = 1; out.push(n); }
    }
    return out.sort(function(a, b){ return a - b; });
  }
  return (+c.row >= 1) ? [+c.row] : [];
}

function validateRow(row, rowNo){
  if (!row || !row.pickup) return 'a row with no team to pick up';
  var c = row.cond || {type: 'always'};
  if (['always', 'won', 'lost'].indexOf(c.type) === -1) return 'unknown condition "' + c.type + '"';
  if (c.type !== 'always'){
    var rs = condRows(c);
    if (!rs.length) return 'a condition with no row number';
    /* A CONDITION CAN ONLY LOOK BACKWARDS. Row 2 asking about row 5 is not a rule, it is a loop:
       row 5 has not run yet, and making it run early would reorder the owner's own priorities. */
    for (var i = 0; i < rs.length; i++){
      if (rs[i] >= rowNo)
        return 'row ' + rowNo + ' asks about row ' + rs[i] + ', which runs later';
    }
  }
  if ((row.drops || []).length > MAX_DROPS) return 'more than ' + MAX_DROPS + ' drops';
  return null;
}

/* The first team on the drop list this seat can actually give up right now. Order is the owner's
   priority, so it is FIRST legal and not best legal. Returns null when there is none, which is
   the 'no_drop' ending: Casey, 9 Sep 2026 -- "if every listed drop is already gone, then the
   owner can't make the trade. They did not provide enough backups, so it fails and you move on." */
function pickDrop(league, key, row, used){
  var roster = league.rosters[key] || [];
  var hold = (league.holdMet || {})[key] || {};
  var drops = row.drops || [];
  /* WHY each name was passed over, so 'no drop left' can say which rule did it rather than
     leaving the owner to guess between four of them. */
  var why = [];
  for (var i = 0; i < drops.length; i++){
    var d = drops[i];
    if (!d) continue;
    if (used[d]){ why.push(d + ' was already used by an earlier request'); continue; }
    if (roster.indexOf(d) === -1){ why.push(d + ' is not on the roster'); continue; }
    if (hold[d] === false){ why.push(d + ' has not finished its hold'); continue; }
    if ((league.tradeAwayOK || {})[d] === false){
      why.push(d + ' has no regular season games left, so it cannot be traded away'); continue;
    }
    if (!sameSide(league, row.pickup, d)){
      why.push(d + ' is not the same kind of team as ' + row.pickup); continue;
    }
    return {drop: d, why: why};
  }
  return {drop: null, why: why};
}

/* ---------------------------------------------------------------------------------------------
 * THE RUN. One division at a time, one ROW INDEX at a time: every owner's row 1 is contested
 * before any owner's row 2, because a row list is a priority order and resolving one owner's
 * whole list first would hand them the board.
 *
 * THE STAND-ASIDE RULE IS BETWEEN TWO OWNERS, NOT ACROSS THE WHOLE WEEK.
 * Casey, 10 Sep 2026: "I only get excluded if I won and I'm going up against one of the owners
 * that lost to me in the previous Peloton ... if I win the first Peloton, and then in the second
 * Peloton I am going up against an owner that was not in the first Peloton, then I get to be in
 * that Peloton again."
 *
 * So beating somebody creates a DEBT to that person and to nobody else. Read it as: you beat me,
 * so the next one we both want is mine.
 *   - You are held out of a contest only if somebody you owe is IN that contest.
 *   - Winning against different owners does not hold you out. This was the first reading and it
 *     was wrong: it benched an owner against people who had never lost anything to them.
 *   - The debt is settled the moment the owner you owe GETS A TEAM. Casey's own example: A beats
 *     B, A stands aside while B wins the next one, and then "if team A and team B go for the
 *     same team again in the third Peloton, because they too both won ... there is no exclusion
 *     at that point." Any acquisition settles it, contested or not -- the promise was that B
 *     gets a turn, and B has had one.
 *   - Winning UNCONTESTED creates no debt. Nobody was beaten, so nobody is owed anything.
 *
 * `policy` keeps the earlier reading available as 'any-win' so the two can be compared side by
 * side rather than argued about. 'pairwise' is the rule.
 *
 * THE LAPSE IS A SAFETY NET, NOT A CASE. If every entrant is excluded the exclusion steps aside
 * rather than leaving a team awarded to nobody -- an absence is not an answer. Under 'pairwise'
 * that should be unreachable: beating somebody CLEARS what you owed them, so debts cannot form a
 * closed ring. It stays because "should be unreachable" is a claim about today's rules.
 * ------------------------------------------------------------------------------------------ */
function resolve(opts){
  var league   = opts.league;
  var requests = opts.requests || [];
  var week     = opts.week;
  var seed     = opts.seed == null ? 'RFL' : opts.seed;
  var policy   = opts.policy || 'pairwise';        // or 'any-win', the earlier reading
  /* The window this run belongs to, stamped onto every transaction it produces. The
     resolver does not own a calendar -- whoever calls it does. */
  var win      = opts.window || {};
  /* The league's per-trade fee, stamped onto every transaction this run creates. Null
     means the caller did not say, and a row with no fee is read as the standard rate by
     whatever displays it -- never as zero. */
  var fee      = opts.fee == null ? null : Number(opts.fee);

  /* The resolver never mutates what it was handed. Bob re-running a week must not depend on
     whether he re-ran it before. */
  var rosters = {}, out = {}, log = [];
  for (var k in league.rosters) rosters[k] = (league.rosters[k] || []).slice();
  /* THE WORKING COPY CARRIES EVERY FIELD THE CHECKS READ. `pools` was left off when it was
     added, so sameSide() saw no pools, returned true for everything, and the like-for-like rule
     silently did nothing -- the suite caught it, which is the whole reason it exists. A copy
     built by listing fields by hand goes stale every time a field is added. */
  var work = {};
  for (var f in league) work[f] = league[f];
  work.rosters = rosters;          // the ONLY field this run is allowed to change

  (league.divisions || []).forEach(function (div){
    var reqs = requests.filter(function (r){ return r.div === div; })
                       .slice().sort(function (a, b){ return a.seat < b.seat ? -1 : 1; });
    if (!reqs.length) return;

    /* WHO OWES A TURN TO WHOM. owes['A'] = {'B': 1} means A beat B and has not yet let B have
       one. Beating somebody creates the debt; that person acquiring ANY team settles it. */
    var owes = {};
    var used = {};            // seat -> {team: true} drops already spent
    var dropped = {};         // team -> why, once it has left a roster THIS run
    var contestNo = 0;
    var settle = function(seat){                  // this seat got a team: nobody owes them now
      for (var s in owes) delete owes[s][seat];
    };
    var blockedBy = function(seat, present){      // who, in THIS contest, is this seat holding up
      var d = owes[seat] || {}, out = [];
      present.forEach(function(x){ if (x !== seat && d[x]) out.push(x); });
      return out;
    };

    reqs.forEach(function (r){ out[seatKey(div, r.seat)] = []; used[r.seat] = {}; });

    for (var idx = 0; idx < MAX_ROWS; idx++){
      var live = [];

      reqs.forEach(function (r){
        var key = seatKey(div, r.seat);
        var row = (r.rows || [])[idx];
        if (!row) return;
        var res = {row: idx + 1, pickup: row.pickup, drop: null, cond: row.cond || {type: 'always'}};

        var bad = validateRow(row, idx + 1);
        if (bad){ res.outcome = OUTCOME.INVALID; res.detail = bad; out[key][idx] = res; return; }

        /* THE CONDITION. "lost" means DID NOT GET IT, for any reason -- lost the flip, stood
           aside, never ran, ran out of drops. Reading it as "contested and lost" would let a
           skipped row silently freeze every row hanging off it. */
        var c = res.cond;
        if (c.type !== 'always'){
          /* ANY, NOT ALL. A condition naming several earlier rows is satisfied as soon as ONE of
             them ended the named way. "Only if I lose trade 1, 2 or 3" runs when any of the three
             was missed, and is skipped only when all three came through. */
          var rs = condRows(c);
          var hit = false;
          for (var ri = 0; ri < rs.length; ri++){
            var earlier = out[key][rs[ri] - 1];
            var gotIt = !!(earlier && GOT[earlier.outcome]);
            if (c.type === 'won' ? gotIt : !gotIt){ hit = true; break; }
          }
          if (!hit){
            var which = rs.length === 1 ? 'row ' + rs[0]
                      : 'any of rows ' + rs.slice(0, -1).join(', ') + ' or ' + rs[rs.length - 1];
            res.outcome = OUTCOME.SKIPPED;
            res.detail = c.type === 'won'
              ? 'set to run only if ' + which + ' came through, and '
                + (rs.length === 1 ? 'it did not' : 'none of them did')
              : 'set to run only if ' + which + ' did not come through, and '
                + (rs.length === 1 ? 'it did' : 'all of them did');
            out[key][idx] = res; return;
          }
        }

        var already = out[key].some(function (p){ return p && GOT[p.outcome] && p.pickup === row.pickup; });
        if (already){ res.outcome = OUTCOME.DUPLICATE; out[key][idx] = res; return; }

        if ((rosters[key] || []).indexOf(row.pickup) !== -1){
          res.outcome = OUTCOME.HAVE_IT; out[key][idx] = res; return;
        }
        var holder = heldBy(work, div, row.pickup);
        if (holder){ res.outcome = OUTCOME.OWNED; res.detail = holder; out[key][idx] = res; return; }
        if ((league.claimOK || {})[row.pickup] === false){
          res.outcome = OUTCOME.NOT_CLAIMABLE; out[key][idx] = res; return;
        }
        if (dropped[row.pickup]){
          /* DROPPED THIS WEEK. From the commissioner's rules: a dropped team is frozen for a
             game before anybody can pick it up. Inside one Monday that is absolute -- nothing
             has been played between the two rows. */
          res.outcome = OUTCOME.JUST_DROPPED; res.detail = dropped[row.pickup];
          out[key][idx] = res; return;
        }
        var pick = pickDrop(work, key, row, used[r.seat]);
        if (!pick.drop){
          /* THE POOL RULE GETS ITS OWN ANSWER when that is the only thing standing in the way.
             "No drop left" and "you offered an NFL team for a college team" are different
             mistakes and the owner fixes them differently. */
          var onlyPool = pick.why.length
            && pick.why.every(function(w){ return /not the same kind of team/.test(w); });
          res.outcome = onlyPool ? OUTCOME.WRONG_POOL : OUTCOME.NO_DROP;
          res.detail = pick.why.join('; ');
          out[key][idx] = res; return;
        }
        var drop = pick.drop;

        res.drop = drop;
        live.push({seat: r.seat, key: key, res: res, idx: idx});
        out[key][idx] = res;
      });

      /* Group this round's live rows by the team they want. Sorted, so the order of contests is
         the same on every machine that runs this. */
      var byTeam = {};
      live.forEach(function (e){ (byTeam[e.res.pickup] = byTeam[e.res.pickup] || []).push(e); });
      Object.keys(byTeam).sort().forEach(function (team){
        var entrants = byTeam[team];
        var award = function (e, outcome, entrantNames){
          e.res.outcome = outcome;
          e.res.entrants = entrantNames;
          var roster = rosters[e.key];
          var at = roster.indexOf(e.res.drop);
          if (at !== -1) roster.splice(at, 1);
          roster.push(team);
          used[e.seat][e.res.drop] = true;
          dropped[e.res.drop] = e.seat + ' dropped it earlier the same afternoon';
          /* GETTING A TEAM SETTLES WHAT ANYONE OWED YOU. Casey, 10 Sep 2026: A beats B, stands
             aside while B wins the next one, and by the third they are level again. Any
             acquisition settles it -- the promise was that B gets a turn, and B has had one. */
          settle(e.seat);
          /* THE LOG ROW *IS* A TRANSACTION ROW. The Transactions tab already lists every trade
             and what each owner owes at the league's per-trade fee; it reads `owner`, `out`,
             `in`, `div`, `window` and `effective`. Emitting anything else here would mean a
             translation step somewhere, and a translation step is a second place the same fact
             is written down. Casey, 10 Sep 2026: "as a trade commits ... you're tying that to
             update the transactions tab to keep track of the trades that have happened as well
             as what each owner owes." */
          /* THE FEE IS RECORDED ON THE ROW, not counted from the rows later. A trade won here
             is a transaction the owner made, so it carries the league's fee; a commissioner's
             correction move is not, and carries zero. The caller supplies the rate rather than
             the resolver knowing it — the rate is a league rule and this file is not where
             league rules live. */
          log.push({div: div, week: week, owner: e.seat, row: e.res.row,
                    'in': team, out: e.res.drop,
                    how: entrantNames.length > 1 ? 'coin flip' : 'unopposed',
                    contested: entrantNames.length > 1, fee: fee,
                    window: win.label || null, effective: win.effective || null});
        };

        if (entrants.length === 1){
          entrants[0].res.asked = [entrants[0].seat];
          entrants[0].res.aside = [];
          award(entrants[0], OUTCOME.WON_ALONE, [entrants[0].seat]);
          return;
        }

        contestNo++;
        /* THREE LISTS, NOT ONE. `asked` is everybody who put this team on their list; `drawn` is
           who was actually in the coin flip; `aside` is who was held out of it. They used to be
           the same array, and the winner was therefore told "you won the coin flip against Dos
           Pigs and Twitchell/Fryer" when Twitchell/Fryer had stood aside and was never in it.
           Casey, 11 Sep 2026: "because Twitchell Fryer won, they're not eligible to be part of
           round two for that same team, so they should not have been in that second peloton."
           The DRAW was right the whole time; the sentence beside it was not, which is the worse
           of the two -- an owner can only check the rule through what he is told. */
        var names = entrants.map(function (e){ return e.seat; });
        /* PAIRWISE. You are held out only if somebody you owe is in THIS contest -- not because
           you won something earlier against people who are not here. */
        var held = {};
        entrants.forEach(function (e){
          var by = policy === 'any-win' ? (owes[e.seat] && Object.keys(owes[e.seat]).length
                                           ? ['an earlier contest'] : [])
                                        : blockedBy(e.seat, names);
          if (by.length) held[e.seat] = by;
        });
        var eligible = entrants.filter(function (e){ return !held[e.seat]; });
        /* Every entrant held out: the exclusion has nobody left to protect, so it steps aside
           rather than leaving the team unawarded. An absence is not an answer. */
        var lapsed = false;
        if (!eligible.length){ eligible = entrants; lapsed = true; held = {}; }

        var rnd = mulberry32(hash32(flipKey(seed, week, div, team, idx + 1)));
        var winner = eligible[Math.floor(rnd() * eligible.length)] || eligible[0];

        var drawn = eligible.map(function (e){ return e.seat; });
        var aside = entrants.filter(function (e){ return held[e.seat]; })
                            .map(function (e){ return {seat: e.seat, owedTo: held[e.seat]}; });
        entrants.forEach(function (e){
          if (e === winner) return;
          e.res.outcome = held[e.seat] ? OUTCOME.STOOD_ASIDE : OUTCOME.LOST;
          e.res.owedTo = held[e.seat] || null;      // who this seat was standing aside FOR
          e.res.entrants = drawn;                   // who was IN the coin flip
          e.res.asked = names;                      // who put the team on a list
          e.res.aside = aside;                      // who was held out of it, and for whom
          e.res.winner = winner.seat;
          e.res.contest = contestNo;
        });
        /* THE LOG READS ITS `how` AND `contested` OFF THIS, so it has to be the drawn list: two
           owners ask, one stands aside, and the remaining one did not win a coin flip. */
        award(winner, OUTCOME.WON, drawn);
        winner.res.asked = names;
        winner.res.aside = aside;
        winner.res.contest = contestNo;
        winner.res.lapsed = lapsed;
        /* The winner now owes everyone they actually BEAT. Nobody who stood aside was beaten, so
           no debt is created towards them. */
        owes[winner.seat] = owes[winner.seat] || {};
        entrants.forEach(function (e){
          if (e !== winner && !held[e.seat]) owes[winner.seat][e.seat] = 1;
        });
      });
    }
  });

  return {rosters: rosters, results: out, log: log, week: week, seed: seed, policy: policy};
}

/* ---------------------------------------------------------------------------------------------
 * FIRST COME, FIRST SERVED — Monday 4:00pm AZ to Tuesday 5:00pm AZ. No flip, no queue: it either
 * works right now or it says why. Same checks as a peloton row, so the two can never disagree
 * about whether a trade was legal.
 * ------------------------------------------------------------------------------------------ */
function claim(opts){
  var league = opts.league, div = opts.div, seat = opts.seat;
  var key = seatKey(div, seat);
  var row = {pickup: opts.pickup, drops: opts.drops || [], cond: {type: 'always'}};
  var res = {row: null, pickup: opts.pickup, drop: null};

  var bad = validateRow(row, 1);
  if (bad){ res.outcome = OUTCOME.INVALID; res.detail = bad; return res; }
  if ((league.rosters[key] || []).indexOf(row.pickup) !== -1){ res.outcome = OUTCOME.HAVE_IT; return res; }
  var holder = heldBy(league, div, row.pickup);
  if (holder){ res.outcome = OUTCOME.OWNED; res.detail = holder; return res; }
  if ((league.claimOK || {})[row.pickup] === false){ res.outcome = OUTCOME.NOT_CLAIMABLE; return res; }
  var pick = pickDrop(league, key, row, {});
  if (!pick.drop){
    var onlyPool = pick.why.length
      && pick.why.every(function(w){ return /not the same kind of team/.test(w); });
    res.outcome = onlyPool ? OUTCOME.WRONG_POOL : OUTCOME.NO_DROP;
    res.detail = pick.why.join('; ');
    return res;
  }
  res.drop = pick.drop; res.outcome = OUTCOME.WON_ALONE;
  return res;
}
/* Applying a claim is separate from deciding it, so the caller can show the answer before it
   commits — and so the suite can check the decision without a roster to write into. */
function applyClaim(league, div, seat, res){
  if (!GOT[res.outcome]) return false;
  var key = seatKey(div, seat), roster = league.rosters[key];
  var at = roster.indexOf(res.drop);
  if (at !== -1) roster.splice(at, 1);
  roster.push(res.pickup);
  return true;
}
/* A first-come claim produces the SAME transaction row as a coin flip, so the tab that lists
   them does not have to know which kind it was looking at. */
function claimRow(div, seat, res, opts){
  opts = opts || {};
  return {div: div, week: opts.week == null ? null : opts.week, owner: seat, row: null,
          'in': res.pickup, out: res.drop, how: 'first come', contested: false,
          fee: opts.fee == null ? null : Number(opts.fee),
          window: opts.window || null, effective: opts.effective || null};
}

return {resolve: resolve, claim: claim, applyClaim: applyClaim, claimRow: claimRow,
        seatKey: seatKey, heldBy: heldBy,
        OUTCOME: OUTCOME, GOT: GOT, MAX_ROWS: MAX_ROWS, MAX_DROPS: MAX_DROPS,
        condRows: condRows,
        sameSide: sameSide,
        _hash32: hash32, _mulberry32: mulberry32, _flipKey: flipKey};
}));


/* ===== board.js ===== */
/* THE FOUR LEAGUE FACTS A SETTLE NEEDS, IN ONE PLACE.
 *
 * `peloton.js` decides who gets a contested team. It is handed four things it does not work out
 * for itself: what pool each team is in, whose teams have met their hold, which teams have
 * enough games left to be claimed, and which have enough left to be traded away. Those four came
 * out of functions living inside the trades page.
 *
 * THAT WAS FINE WHILE ONLY THE PAGE COULD SETTLE A WEEK. Monday is going back to settling
 * itself, in the back end, and the back end cannot call a function that lives in a page. The
 * obvious move is to copy those four functions across. That is the mistake this project has paid
 * for more than once: two stores of one fact disagree, and here they would disagree about who
 * owns a team. So they live here, and BOTH sides call this.
 *
 * PURE, for the same reasons peloton.js is pure: no DOM, no network, no clock of its own. The
 * date is an argument. A settle that reads the clock cannot be tested on a Monday in December,
 * and cannot be proved to agree with a settle run at a different moment.
 *
 * WHAT A TEAM IS, IN HERE: {n: name, pool: 'FBS'|'FCS'|'NFL', dates: ['YYYY-MM-DD', ...]}.
 * Nothing else about a team matters to any of this -- no rating, no projection, no schedule
 * detail beyond the day each game is played.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Board = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* HOW FAR THROUGH ITS HOLD ONE TEAM IS, ON ONE SEAT.
 *
 * `since` is the day that seat acquired it, or '' for a team it drafted. A drafted team counts
 * every game of its season: Casey, 11 Sep 2026, "a game played on or before draft day counts,
 * because there could be games played before draft day." A traded team starts again from the
 * day it changed hands, because a hold belongs to the OWNER and not to the team.
 *
 * A GAME PLAYED TODAY HAS NOT COUNTED YET. `d < today` is deliberate: the hold is met the day
 * AFTER the third game, which is the same line the Pickups tab draws.
 */
function holdOf(dates, since, today, need) {
  var done = 0, future = [];
  for (var i = 0; i < (dates || []).length; i++) {
    var d = dates[i];
    if (d >= since && d < today) done++;
    else if (d >= today) future.push(d);
  }
  var short = need - done;
  return {
    done: done, need: need, met: short <= 0,
    /* THE DAY THE HOLD FINISHES, or null when the schedule runs out first. A team can reach the
       end of its season still inside its hold. UNKNOWN IS NOT ZERO AND NEITHER IS IMPOSSIBLE:
       `stuck` is which of the two this is, so a caller never has to guess from a null. */
    on: short <= 0 ? null : (future.length >= short ? future[short - 1] : null),
    stuck: short > 0 && future.length < short
  };
}

/* HOW MANY GAMES A TEAM HAS LEFT, counting one played today as still to come. */
function leftOf(dates, today) {
  var n = 0;
  for (var i = 0; i < (dates || []).length; i++) if (dates[i] >= today) n++;
  return n;
}

/* EVERYTHING peloton.js ASKS FOR, BUILT ONCE.
 *
 *   teams       [{n, pool, dates}]
 *   rosters     {'DIV|Seat': [team name, ...]}
 *   acquiredAt  {'DIV|Seat': {team name: 'YYYY-MM-DD'}}
 *   today       'YYYY-MM-DD'
 *   divisions   ['PFD','VFD','SFD']
 *   rules       {hold_games, claim_min, trade_away_min}
 *
 * TWO THRESHOLDS, NOT ONE, and they are different rules. A team coming IN needs `claim_min`
 * games left. A team going OUT needs `trade_away_min`, which is one. So a team can be long past
 * its hold and still be stuck on a roster, and calling that "inside its hold" would hand the
 * owner a reason that is not the reason.
 */
function build(o) {
  var teams = o.teams || [], rules = o.rules || {};
  var need = rules.hold_games || 3;
  var claimMin = rules.claim_min || 3;
  var awayMin = rules.trade_away_min == null ? 1 : rules.trade_away_min;
  var today = o.today;
  var byName = {}, pools = {}, claimOK = {}, tradeAwayOK = {};
  for (var i = 0; i < teams.length; i++) {
    var t = teams[i];
    byName[t.n] = t;
    pools[t.n] = t.pool;
    var left = leftOf(t.dates, today);
    claimOK[t.n] = left >= claimMin;
    tradeAwayOK[t.n] = left >= awayMin;
  }
  var rosters = o.rosters || {}, got = o.acquiredAt || {};
  var holdMet = {};
  Object.keys(rosters).forEach(function (k) {
    holdMet[k] = {};
    (rosters[k] || []).forEach(function (n) {
      var since = ((got[k] || {})[n]) || '';
      var t = byName[n];
      /* A TEAM THE BOARD HAS NEVER HEARD OF CANNOT BE SAID TO HAVE MET ITS HOLD. Saying true
         would let it be dropped on the strength of a name nobody can check. */
      holdMet[k][n] = t ? holdOf(t.dates, since, today, need).met : false;
    });
  });
  return {divisions: o.divisions, rosters: rosters, pools: pools,
          holdMet: holdMet, claimOK: claimOK, tradeAwayOK: tradeAwayOK};
}

/* WHICH ENTRIES A SETTLE ACTUALLY TAKES, AND THE SHAPE THE RESOLVER WANTS THEM IN.
 *
 * This lived in the trades page. It is here because the back end settles Monday too, and the
 * first version of the back end got it wrong in two ways at once: it handed the resolver a map
 * keyed by seat when the resolver wants a LIST, and it skipped both filters below. The suite
 * caught it. That is the whole argument for this file existing.
 *
 * THREE THINGS ARE FILTERED OUT, and each is a different situation:
 *   a row for a DIFFERENT WEEK  -- last week's entry is spent, not pending
 *   a list never SENT           -- a draft somebody typed and left is not an entry
 *   a row with no pickup        -- an empty line in the middle of a list
 */
function pending(requests, week) {
  var out = [];
  Object.keys(requests || {}).forEach(function (k) {
    var r = requests[k];
    if (!r || r.week !== week || !(r.rows || []).length) return;
    if (!r.submitted) return;
    var b = k.split('|');
    out.push({seat: b[1], div: b[0],
              rows: r.rows.filter(function (x) { return x && x.pickup; })});
  });
  return out.filter(function (r) { return r.rows.length; });
}

/* WHICH LEAGUE WEEK A DAY FALLS IN. One implementation, because a settle that disagrees with the
   page about the week number settles the wrong set of entries. */
function weekOf(day, week1) {
  var w1 = Date.parse((week1 || '2026-09-08') + 'T00:00:00Z');
  var n = Math.floor((Date.parse(String(day).slice(0, 10) + 'T00:00:00Z') - w1) / 604800000) + 1;
  return n < 0 ? 0 : n;
}

return {holdOf: holdOf, leftOf: leftOf, build: build, pending: pending, weekOf: weekOf};
}));


/* ===== worker.js ===== */
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

/* NEWEST FIRST, CAPPED, AND WRITTEN IN THE SAME BREATH AS THE CHANGE ITSELF. Two stores of one
   fact are written together or one of them lies -- so a change that fails to save never gets a
   history line, because the line is written after the access list it describes. */
const LOG_MAX = 200;
async function noteAccess(env, div, seat, what, by) {
  const log = await getJSON(env, 'accesslog', []);
  log.unshift({ at: new Date().toISOString(), div, seat, what, by: by || '' });
  await putJSON(env, 'accesslog', log.slice(0, LOG_MAX));
}

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

/* WHERE ONE PERSON'S OWN SETTINGS LIVE. Built from the sign-in and nothing else. */
const prefsKey = (who) => 'prefs|' + who.div + '|' + who.seat + '|' + who.member;

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
    /* WHETHER THE SETUP WORD IS CONFIGURED, AND NEVER WHAT IT IS.
       Cloudflare does not list secrets on the bindings diagram, so the only way to tell from
       outside was to try using it -- and a wrong word and a missing one give the same answer, on
       purpose. A yes-or-no says what is needed and gives away nothing: knowing that a password
       exists has never helped anybody guess it. */
    return out({ ok: true, at: new Date().toISOString(), seats: access.length,
                 ready: !!box.state, rev: box.rev, store: 'cloudflare',
                 admin_set: !!env.ADMIN, cron: '0 23 * * 1 (Mon 4:00pm AZ)' });
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

  /* ---- ONE PERSON'S OWN SETTINGS -------------------------------------------------------
   * Casey's watch list, and anything like it later. It is PER PERSON, not per seat: he asked
   * for it to follow HIM between his phone and his laptop, and a seat can hold two people who
   * would not want each other's shortlist.
   *
   * ITS OWN KEY, NOT A ROW IN A SHARED MAP. Thirty-three people writing into one document is a
   * lost update waiting for the week somebody notices their list is short. A key each cannot
   * collide at all.
   *
   * THE SEAT AND PERSON COME FROM THE SIGN-IN, never from anything the page sends, so nobody
   * can read or write somebody else's.
   */
  if (fn === 'prefs') {
    const v = await getJSON(env, prefsKey(who), {});
    return out({ ok: true, prefs: v });
  }

  if (fn === 'setprefs') {
    const v = p('prefs');
    if (v == null || typeof v !== 'object') {
      return out({ ok: false, why: 'bad', note: 'there were no settings in that' });
    }
    await putJSON(env, prefsKey(who), v);
    return out({ ok: true, at: new Date().toISOString() });
  }

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
      /* AN OWNER GETS THEIR OWN ANSWER AND NOBODY ELSE'S. The whole results object was going out
         to every reader, and a refused row names the team somebody else asked for -- exactly what
         `othersWaiting` exists to keep quiet. The settled TRANSACTIONS are public; the wish lists
         behind them are not. */
      results: (function () {
        const R = s.results;
        if (!R || !R.results) return null;
        return { week: R.week, at: R.at, results: { [mine]: R.results[mine] || [] } };
      })(),
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
      /* THE WEEK GOES ON THE ROW. A settle only takes entries stamped with the week it is
         settling -- last week's list is spent, not pending. The first version of this stored no
         week at all, so every entry sent through here would have been skipped on Monday and the
         page would have shown a week that settled nothing. */
      s.requests[mine] = { div: who.div, seat: who.seat, rows,
                           week: p('week') == null ? null : Number(p('week')),
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

  /* THE ACCESS HISTORY LIVES HERE, BECAUSE THIS IS WHERE THE CHANGES HAPPEN. Casey, 14 Sep 2026:
     the history card on the Access List still pointed at the Log tab of a spreadsheet that no
     longer exists. A page cannot keep this itself -- one commissioner's browser would only ever
     hold the changes that commissioner made, under a sentence promising all of them. Bob changes
     an address on his laptop and Casey has to be able to read it. So it is one list, kept next to
     the access list it describes, and every commissioner reads the same one. */
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
    await noteAccess(env, seat.div, seat.seat,
      'new code issued to ' + hit.map(memberLabel).join(' and ')
      + (gone ? ', ' + gone + ' device' + (gone === 1 ? '' : 's') + ' signed out'
              : ', nothing was signed in'),
      who.email || who.seat);
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
    /* WHAT TO WRITE IN THE HISTORY, gathered as it happens rather than worked out afterwards
       by comparing two copies. One request can change three things. */
    const said = [];
    const status = p('status');
    /* STATUS IS THE SEAT'S. A seat leaving the league takes its people with it. */
    if (status === 'active' || status === 'inactive') {
      if (seat.status !== status) {
        said.push(status === 'inactive' ? 'seat switched off' : 'seat put back');
      }
      seat.status = status;
    }

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
      said.push('added ' + addr + ' as a second owner');
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
      if (role === 'owner' || role === 'commissioner') {
        if ((m.role || 'owner') !== role) {
          said.push(memberLabel(m) + ' made a ' + role);
        }
        m.role = role;
      }
      /* CHANGING AN ADDRESS DOES NOT SIGN ANYBODY OUT. The key points at the id, not the
         address, which is the whole reason the id exists. */
      if (email != null) {
        const was = String(m.email || '').trim();
        const now = String(email).trim();
        if (was !== now) said.push('address changed from ' + (was || 'nothing') + ' to '
                                  + (now || 'nothing'));
        m.email = now;
      }
      if (label != null) m.label = String(label).trim();
    }
    /* THE LAST COMMISSIONER CANNOT BE STOOD DOWN. That is the locked room again. */
    if (!anyCommish(access)) {
      return out({ ok: false, why: 'lastone',
                   note: 'that would leave the league with no commissioner' });
    }
    await putJSON(env, 'access', access);
    if (said.length) {
      await noteAccess(env, seat.div, seat.seat, said.join('; '), who.email || who.seat);
    }
    return out({ ok: true, added: added && { member: added.id, code: added.code },
                 members: seat.members.map((m) => ({ member: m.id, email: m.email || '',
                   who: memberLabel(m), role: m.role || 'owner', code: m.code })) });
  }

  /* THE SAME SETTLE THE SCHEDULE RUNS, ASKED FOR BY HAND. Not a second implementation: Run It
     on the page and this call and the Monday schedule all end in settleWeek(). */
  if (fn === 'settle') {
    return out(await settleWeek(env, {week: p('week') == null ? null : Number(p('week')),
                                      force: !!p('force'), by: who.seat}));
  }

  if (fn === 'load') {
    const box = await readState(env);
    const access = await getJSON(env, 'access', []);
    const keys = await getJSON(env, 'keys', {});
    /* WHEN EACH SIGN-IN WAS MADE, NOT ONLY HOW MANY THERE ARE.
     *
     * Casey, 15 Sep 2026: "it's showing that Tom Rush has two devices signed in. He has not been
     * given the link. It shows 10 devices for me, which I'm only signed into my phone and my
     * laptop."
     *
     * The number was honest but the word was not. This counts KEYS -- one is written every time
     * somebody signs in, and nothing ever removes one. Casey has ten because a phone, a laptop, a
     * home-screen icon and the old web address are four different browsers as far as a stored key
     * is concerned, and every sign-in during a fortnight of testing left one behind. Calling that
     * "devices signed in" reads as ten people holding his seat.
     *
     * A count with no dates cannot be judged. The dates come back with it now, so a leftover from
     * testing looks like what it is, and Retire and Issue a New Code clears them.
     */
    const counts = {}, perPerson = {}, whenPerson = {};
    for (const k of Object.keys(keys)) {
      const r = keys[k];
      counts[r.div + '|' + r.seat] = (counts[r.div + '|' + r.seat] || 0) + 1;
      const pk = r.div + '|' + r.seat + '|' + r.member;
      perPerson[pk] = (perPerson[pk] || 0) + 1;
      (whenPerson[pk] = whenPerson[pk] || []).push(r.issued || '');
    }
    for (const pk of Object.keys(whenPerson)) whenPerson[pk].sort();
    return out({ ok: true, rev: box.rev, state: box.state,
                 access: access.map((a) => ({ div: a.div, seat: a.seat, status: a.status,
                   members: membersOf(a).map((m) => ({ member: m.id, email: m.email || '',
                     who: memberLabel(m), role: m.role || 'owner', code: m.code,
                     signedIn: perPerson[a.div + '|' + a.seat + '|' + m.id] || 0,
                     signedWhen: whenPerson[a.div + '|' + a.seat + '|' + m.id] || [] })) })),
                 signedIn: counts,
                 accessLog: await getJSON(env, 'accesslog', []),
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

/* ---------- SETTLING A WEEK, IN HERE ------------------------------------------------------
 *
 * Casey, 14 Sep 2026: "I'd prefer it to be automatic." It used to be, on a schedule Google kept,
 * and that died with the account.
 *
 * NOTHING ABOUT HOW A WEEK IS DECIDED LIVES HERE. `Peloton.resolve` decides it and `Board.build`
 * works out the four league facts it is handed. Both are the same files the page uses, bundled
 * in above. This function only fetches, calls, and writes down -- if it started making a
 * judgement of its own, the automatic Monday and the manual one could part company.
 *
 * THE BOARD IS FETCHED, NOT STORED. It is published beside this Worker's own source, so the
 * board a week is settled against is the board that is actually on the site. A copy kept in KV
 * would go stale the first time a rebuild was not pushed.
 */
const BOARD_URL = 'https://cdwiedeman-cpu.github.io/owners-league-dashboard/backend/board.json';

/* ARIZONA DOES NOT MOVE ITS CLOCKS. UTC-7 all year, so this is right in January and in July --
   do not "fix" it in March. The league runs on AZ time and every date in the state is AZ. */
function azNow(at) {
  const d = at ? new Date(at) : new Date();
  return new Date(d.getTime() - 7 * 3600 * 1000);
}
const azDay = (at) => azNow(at).toISOString().slice(0, 10);

function weekOf(day, week1) {
  const w1 = Date.parse((week1 || '2026-09-08') + 'T00:00:00Z');
  const n = Math.floor((Date.parse(day + 'T00:00:00Z') - w1) / 604800000) + 1;
  return n < 0 ? 0 : n;
}

const when0 = () => new Date().toISOString();
async function settleWeek(env, opts) {
  const o = opts || {};
  const board = await fetch(BOARD_URL, {cf: {cacheTtl: 60}}).then((r) => r.json());
  if (!board || !board.teams || !board.teams.length) {
    return {ok: false, why: 'noboard', note: 'the board could not be read, so nothing was settled'};
  }
  const box = await readState(env);
  const s = box.state;
  if (!s) return {ok: false, why: 'empty', note: 'the league has not been set up yet'};

  const day = o.day || azDay();
  const week = o.week != null ? Number(o.week) : weekOf(day, board.week1);

  /* A WEEK IS SETTLED ONCE. The schedule could fire twice, or fire after somebody pressed Run It,
     and settling again would move rosters a second time on requests that are already spent. */
  if (!o.force && s.ranWeeks && s.ranWeeks[week]) {
    return {ok: false, why: 'already', week, note: 'that week has already been settled'};
  }

  /* THE SAME SELECTION THE PAGE MAKES, out of the same file. The first version of this built a
     map keyed by seat and skipped both filters; the resolver wants a LIST, and a draft nobody
     sent is not an entry. */
  const pending = Board.pending(s.requests, week);
  if (!pending.length) {
    /* NOTHING TO DO IS NOT A FAILURE, and the week is still marked as run so the schedule does
       not come back to it every hour. */
    s.ranWeeks = s.ranWeeks || {};
    s.ranWeeks[week] = {at: new Date().toISOString(), n: 0, by: o.by || 'schedule'};
    await writeState(env, s, box.rev + 1);
    return {ok: true, week, settled: 0, note: 'nobody sent a list, so there was nothing to settle'};
  }

  /* A WEEK THE SCHEDULE SETTLED MUST BE UNDOABLE TOO. Run It on the page took a snapshot before
     it moved anything; this did not, so the first automatic Monday would have been the one week
     of the season with no way back. The shape is exactly what `doUndo()` on the page reads --
     two stores of one fact, written by one function each, so they have to agree on the shape. */
  const snap = {
    rosters: JSON.parse(JSON.stringify(s.rosters || {})),
    requests: JSON.parse(JSON.stringify(s.requests || {})),
    acquiredAt: JSON.parse(JSON.stringify(s.acquiredAt || {})),
    logLen: (s.log || []).length,
    week, at: when0(),
  };

  const league = Board.build({
    teams: board.teams, rosters: s.rosters, acquiredAt: s.acquiredAt,
    today: day, divisions: board.divisions, rules: board.rules,
  });
  const res = Peloton.resolve({league, requests: pending, week,
                               seed: s.seed || 'RFL', fee: board.rules.trade_cost});

  s.rosters = res.rosters;
  s.acquiredAt = s.acquiredAt || {};
  const when = new Date().toISOString();
  (res.log || []).forEach((e) => {
    const k = e.div + '|' + e.owner;
    (s.acquiredAt[k] = s.acquiredAt[k] || {})[e['in']] = String(e.effective || day).slice(0, 10);
    s.log = s.log || [];
    s.log.unshift(Object.assign({when}, e));
  });
  s.results = {week, at: when, results: res.results, log: res.log};
  /* `since` IS THE LOG LENGTH AFTER THE RUN, which is what tells the page what arrived
     afterwards -- a first come claim taken between the run and the undo. */
  snap.since = (s.log || []).length;
  s.undo = snap;
  s.requests = {};
  s.ranWeeks = s.ranWeeks || {};
  const prev = s.ranWeeks[week];
  s.ranWeeks[week] = {at: when, n: (prev ? prev.n : 0) + (res.log || []).length,
                      by: o.by || 'schedule'};
  await writeState(env, s, box.rev + 1);
  return {ok: true, week, settled: (res.log || []).length, at: when};
}

export default {
  /* MONDAY, 4:00pm ARIZONA. The cron is `0 23 * * 1` in UTC, which is Monday 16:00 AZ all year
     because Arizona does not observe daylight saving.
     IT IS A SWITCH, NOT A LAW. `autoPeloton` is the same flag the Run It tab already shows as
     Automatically / I Do It Myself. Set to do-it-myself, this fires and does nothing, and the
     commissioner presses the button when they are ready. */
  async scheduled(event, env, ctx) {
    try {
      const box = await readState(env);
      const s = box.state;
      if (!s) return;
      if (s.autoPeloton === false) return;
      await settleWeek(env, {at: event && event.scheduledTime, by: 'schedule'});
    } catch (e) {
      /* A SCHEDULED RUN HAS NOBODY WATCHING IT. Swallowing the error would leave a Monday that
         quietly did not happen, so it is written where the next person to look will find it. */
      try {
        await putJSON(env, 'lastScheduleError',
          {at: new Date().toISOString(), note: String((e && e.message) || e)});
      } catch (e2) {}
    }
  },

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
