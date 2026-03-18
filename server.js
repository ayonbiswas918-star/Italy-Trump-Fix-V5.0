/**
 * Italy Card Game — Server v6
 * Fixes: reconnect, round-2 stuck, missing card, discard-all
 */
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────
const RANKS    = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS    = ['spades','hearts','diamonds','clubs'];
const RANK_VAL = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
const FACE     = new Set(['A','J','Q','K']);
const OPP_TARGET = 5;

// ─────────────────────────────────────────────
//  UTILS
// ─────────────────────────────────────────────
function createDeck(){
  const d=[];
  for(const s of SUITS) for(const r of RANKS) d.push({suit:s,rank:r,id:`${r}_${s}`});
  return d;
}
function shuffle(a){
  const b=[...a];
  for(let i=b.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]];}
  return b;
}
function genCode(){let c;do{c=Math.random().toString(36).substr(2,6).toUpperCase();}while(rooms.has(c));return c;}
const teamOf  = p=>p%2===0?'A':'B';
const otherTeam=t=>t==='A'?'B':'A';
function sortHand(h){
  // Alternating color order: Spades(black) | Hearts(red) | Clubs(black) | Diamonds(red)
  // This way two black groups are separated by red groups — easy to read at a glance
  const so={spades:0,hearts:1,clubs:2,diamonds:3};
  return [...h].sort((a,b)=>a.suit!==b.suit?so[a.suit]-so[b.suit]:RANK_VAL[b.rank]-RANK_VAL[a.rank]);
}
function cardBeats(ch,cur,lead,trump,rev){
  const ct=rev&&ch.suit===trump,wt=rev&&cur.suit===trump;
  if(ct&&!wt)return true; if(!ct&&wt)return false;
  if(ct&&wt)return RANK_VAL[ch.rank]>RANK_VAL[cur.rank];
  if(ch.suit===lead&&cur.suit!==lead)return true;
  if(ch.suit!==lead&&cur.suit===lead)return false;
  if(ch.suit===lead)return RANK_VAL[ch.rank]>RANK_VAL[cur.rank];
  return false;
}

// ─────────────────────────────────────────────
//  ROOM MAP
// ─────────────────────────────────────────────
const rooms = new Map();

// ─────────────────────────────────────────────
//  ROOM / STATE FACTORIES
// ─────────────────────────────────────────────
function createRoom(hostId, hostName, hostEmoji, hostSid){
  return {
    code:    null,
    hostSid: hostSid,           // sessionId of host (always allowed to start/restart)
    players: [{
      id:        hostId,
      name:      hostName,
      position:  0,
      sessionId: hostSid,
      emoji:     hostEmoji||'🎴',
      online:    true,
    }],
    emojis:     { 0: hostEmoji||'🎴' },
    settings:   { matchTarget: 30 },
    gameState:  null,
    readySet:   new Set(),       // stores sessionIds (stable across reconnect)
  };
}

function freshState(prev, target){
  const dealerPos    = prev ? (prev.dealerPos+1)%4 : 0;
  const callingStart = (dealerPos+1)%4;
  return {
    phase:         'calling',
    deck:          [],
    hands:         {0:[],1:[],2:[],3:[]},
    discardedHands:{},          // pos → cards, for discard-all tracking
    discardedFlags:{},          // pos → true if already discarded once
    powerCard:     null,
    trumpSuit:     null,
    trumpRevealed: false,
    currentBid:    0,
    currentBidder: -1,
    dealerPos,
    callingStart,
    callingTurn:   callingStart,
    callingCount:  0,
    currentPlayer: callingStart,
    currentTrick:  [],
    leadSuit:      null,
    tricksWon:     { A:0, B:0 },
    scores:        prev ? { ...prev.scores } : { A:0, B:0 },
    matchTarget:   target,
    roundNumber:   prev ? prev.roundNumber : 1,
    trickNumber:   1,
  };
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
const nm  = (room,pos) => room.players.find(p=>p.position===pos)?.name||`P${pos+1}`;
const pi  = room => room.players.map(p=>({
  id:p.id, name:p.name, position:p.position, team:teamOf(p.position), online:p.online
}));
function sk(room, pos){
  const p = room.players.find(pl=>pl.position===pos);
  return p ? io.sockets.sockets.get(p.id) : null;
}
function playerBySid(room, sid){
  return room.players.find(p=>p.sessionId===sid);
}

// Send full game state to a reconnecting player
function sendStateToPlayer(room, pos){
  const gs = room.gameState;
  const s  = sk(room, pos);
  if(!s || !gs) return;

  const phase = gs.phase;

  // Always send their current hand
  s.emit('handUpdate', { hand: gs.hands[pos] || [] });

  // Send round info so UI switches to game screen
  s.emit('roundBegin', {
    roundNumber:     gs.roundNumber,
    scores:          gs.scores,
    players:         pi(room),
    matchTarget:     gs.matchTarget,
    dealerPos:       gs.dealerPos,
    dealerName:      nm(room, gs.dealerPos),
    firstActiveName: nm(room, gs.callingStart),
    firstActivePos:  gs.callingStart,
    emojis:          room.emojis,
    isReconnect:     true,
  });

  // Re-send phase-specific state
  if(phase === 'calling'){
    s.emit('callingStarted',{
      callerPos:  gs.callingTurn,
      callerName: nm(room, gs.callingTurn),
      currentBid: gs.currentBid,
    });
    if(gs.callingTurn === pos){
      const forced = gs.callingCount===3 && gs.currentBid===0;
      s.emit('yourCallingTurn',{
        currentBid: gs.currentBid,
        canPass: !forced,
        hand: gs.hands[pos],
      });
    }
  } else if(phase==='selectingPowerCard' && gs.currentBidder===pos){
    s.emit('selectPowerCard',{ hand: gs.hands[pos] });
  } else if(phase==='dealing2' || phase==='playing'){
    if(gs.trumpRevealed){
      s.emit('trumpRevealed',{
        trumpSuit:     gs.trumpSuit,
        powerCard:     gs.powerCard?.card || null,
        revealedByPos: -1,
        revealedByName:'',
        bidderPos:     gs.currentBidder,
        autoReveal:    true,
      });
    }
    if(phase==='playing' && gs.currentPlayer===pos){
      sendTurn(room, pos);
    } else {
      s.emit('turnChanged',{
        currentPlayer:     gs.currentPlayer,
        currentPlayerName: nm(room, gs.currentPlayer),
      });
    }
    // Re-send trick cards played so far this trick
    if(gs.currentTrick.length > 0){
      gs.currentTrick.forEach(tc=>{
        s.emit('cardPlayed',{
          position:   tc.position,
          name:       nm(room, tc.position),
          card:       tc.card,
          trickSoFar: gs.currentTrick,
        });
      });
    }
  } else if(phase==='roundEnd'){
    // Re-open round end panel
    const ct  = teamOf(gs.currentBidder);
    const ot  = otherTeam(ct);
    const rs  = gs.lastRoundScore || {A:0,B:0};
    s.emit('roundEnd',{
      tricksWon:   gs.tricksWon,
      bid:         gs.currentBid,
      bidder:      gs.currentBidder,
      bidderTeam:  ct,
      oppTarget:   OPP_TARGET,
      roundScore:  rs,
      totalScores: gs.scores,
      message:     gs.lastRoundMsg || '',
      powerCard:   gs.lastPowerCard || null,
    });
    s.emit('readyCount',{ ready: room.readySet.size, total: room.players.length });
  }
}

// ─────────────────────────────────────────────
//  GAME LOGIC HELPERS
// ─────────────────────────────────────────────
function validCards(gs,pos,hand){
  if(gs.currentTrick.length===0) return hand;
  // Must follow the lead suit if possible
  const lead=hand.filter(c=>c.suit===gs.leadSuit);
  if(lead.length>0) return lead;
  // No lead suit cards → player can play ANY card freely (trump is optional, not forced)
  return hand;
}
function trickWin(trick,lead,trump,rev){
  if(!trick.length) return null;
  let w=trick[0];
  for(let i=1;i<trick.length;i++) if(cardBeats(trick[i].card,w.card,lead,trump,rev)) w=trick[i];
  return w.position;
}
function canReveal(gs,pos,hand){
  if(gs.trumpRevealed||!gs.powerCard||gs.currentTrick.length===0) return false;
  return gs.leadSuit ? !hand.some(c=>c.suit===gs.leadSuit) : false;
}
function hasFaceCard(hand){ return hand.some(c=>FACE.has(c.rank)); }

// ─────────────────────────────────────────────
//  GAME FLOW
// ─────────────────────────────────────────────
function beginRound(room){
  const gs = freshState(room.gameState, room.settings.matchTarget);
  room.gameState = gs;
  room.readySet.clear();

  gs.deck = shuffle(createDeck());
  // Deal 5 cards to each player starting from left of dealer
  for(let i=0;i<5;i++)
    for(let o=1;o<=4;o++)
      gs.hands[(gs.dealerPos+o)%4].push(gs.deck.shift());
  for(let p=0;p<4;p++) gs.hands[p] = sortHand(gs.hands[p]);

  gs.phase = 'calling';

  io.to(room.code).emit('roundBegin',{
    roundNumber:     gs.roundNumber,
    scores:          gs.scores,
    players:         pi(room),
    matchTarget:     gs.matchTarget,
    dealerPos:       gs.dealerPos,
    dealerName:      nm(room, gs.dealerPos),
    firstActiveName: nm(room, gs.callingStart),
    firstActivePos:  gs.callingStart,
    emojis:          room.emojis,
  });

  // Send each player their initial 5 cards
  room.players.forEach(p=>{
    const s = sk(room, p.position);
    if(s) s.emit('handUpdate',{ hand: gs.hands[p.position], dealPhase:'initial' });
  });

  setTimeout(()=>startCalling(room), 800);
}

function startCalling(room){
  const gs = room.gameState;
  io.to(room.code).emit('callingStarted',{
    callerPos:  gs.callingStart,
    callerName: nm(room, gs.callingStart),
    currentBid: 0,
  });
  promptCaller(room, gs.callingStart, 0, true);
}

function promptCaller(room, pos, bid, canPass){
  const s = sk(room, pos);
  if(s) s.emit('yourCallingTurn',{
    currentBid: bid,
    canPass,
    hand: room.gameState.hands[pos],
  });
}

function advanceCalling(room){
  const gs = room.gameState;
  gs.callingCount++;

  if(gs.callingCount >= 4){
    // All 4 players had their turn
    if(gs.currentBid === 0){ gs.currentBid=7; gs.currentBidder=gs.dealerPos; }
    io.to(room.code).emit('callingDone',{
      bidder:     gs.currentBidder,
      bidderName: nm(room, gs.currentBidder),
      bid:        gs.currentBid,
    });
    setTimeout(()=>dealRest(room), 1000);
    return;
  }

  gs.callingTurn = (gs.callingStart + gs.callingCount) % 4;
  const forced   = gs.callingCount===3 && gs.currentBid===0;
  io.to(room.code).emit('callingTurn',{
    callerPos:  gs.callingTurn,
    callerName: nm(room, gs.callingTurn),
    currentBid: gs.currentBid,
    canPass:    !forced,
  });
  promptCaller(room, gs.callingTurn, gs.currentBid, !forced);
}

function dealRest(room){
  const gs = room.gameState;
  gs.phase = 'dealing2';

  // Two rounds of 4 cards to each player, starting left of dealer
  for(let r=0;r<2;r++)
    for(let o=1;o<=4;o++){
      const pos = (gs.dealerPos+o)%4;
      for(let i=0;i<4&&gs.deck.length>0;i++) gs.hands[pos].push(gs.deck.shift());
    }

  for(let p=0;p<4;p++) gs.hands[p] = sortHand(gs.hands[p]);

  room.players.forEach(p=>{
    const s = sk(room, p.position);
    if(s) s.emit('fullHandDealt',{
      hand:          gs.hands[p.position],
      bidder:        gs.currentBidder,
      bid:           gs.currentBid,
      powerCardSuit: p.position===gs.currentBidder ? (gs.powerCard?.card?.suit??null) : null,
    });
  });

  io.to(room.code).emit('dealingComplete',{
    bidder:     gs.currentBidder,
    bidderName: nm(room, gs.currentBidder),
    bid:        gs.currentBid,
  });

  setTimeout(()=>startPlay(room), 1200);
}

function startPlay(room){
  const gs = room.gameState;
  gs.phase         = 'playing';
  gs.currentPlayer = gs.callingStart;
  gs.trickNumber   = 1;

  io.to(room.code).emit('playingStarted',{
    currentPlayer:     gs.currentPlayer,
    currentPlayerName: nm(room, gs.currentPlayer),
    trickNumber:       1,
  });

  sendTurn(room, gs.currentPlayer);
}

function sendTurn(room, pos){
  const gs   = room.gameState;
  let   hand = gs.hands[pos];

  // Auto-return power card if bidder has NO cards left (trump never revealed)
  if(hand.length===0 && gs.powerCard && gs.powerCard.position===pos){
    const card       = gs.powerCard.card;
    gs.hands[pos]    = [card];
    gs.trumpRevealed = true;
    gs.trumpSuit     = card.suit;
    gs.powerCard     = null;
    hand             = gs.hands[pos];
    io.to(room.code).emit('trumpRevealed',{
      trumpSuit:gs.trumpSuit, powerCard:card,
      revealedByPos:pos, revealedByName:nm(room,pos),
      bidderPos:pos, autoReveal:true,
    });
    const bs = sk(room, pos);
    if(bs) bs.emit('handUpdate',{ hand });
  }

  const vids = validCards(gs, pos, hand).map(c=>c.id);
  const cr   = canReveal(gs, pos, hand);

  io.to(room.code).emit('turnChanged',{
    currentPlayer:     pos,
    currentPlayerName: nm(room, pos),
  });

  const s = sk(room, pos);
  if(s) s.emit('yourTurn',{
    validCardIds:  vids,
    leadSuit:      gs.leadSuit,
    trumpSuit:     gs.trumpRevealed ? gs.trumpSuit : null,
    trumpRevealed: gs.trumpRevealed,
    canRevealTrump:cr,
  });
}

function resolveTrick(room){
  const gs    = room.gameState;
  const trick = gs.currentTrick;

  let w = trick[0];
  for(let i=1;i<trick.length;i++)
    if(cardBeats(trick[i].card, w.card, gs.leadSuit, gs.trumpSuit, gs.trumpRevealed))
      w = trick[i];

  const wt = teamOf(w.position);
  gs.tricksWon[wt]++;
  const total = gs.tricksWon.A + gs.tricksWon.B;

  io.to(room.code).emit('trickComplete',{
    winnerPos:   w.position,
    winnerName:  nm(room, w.position),
    winnerTeam:  wt,
    trickCards:  trick,
    tricksWon:   gs.tricksWon,
    trickNumber: gs.trickNumber,
  });

  gs.currentTrick = [];
  gs.leadSuit     = null;
  gs.trickNumber++;

  if(total >= 13){
    setTimeout(()=>endRound(room), 2000);
  } else {
    gs.currentPlayer = w.position;
    setTimeout(()=>{
      io.to(room.code).emit('newTrickStarting',{
        trickNumber: gs.trickNumber,
        leader:      gs.currentPlayer,
        leaderName:  nm(room, gs.currentPlayer),
      });
      sendTurn(room, gs.currentPlayer);
    }, 2000);
  }
}

function endRound(room){
  const gs = room.gameState;

  // If trump was never revealed, the power card is still with the bidder concept:
  // Return it now so round end shows the card
  if(gs.powerCard){
    gs.trumpRevealed = true;
    gs.trumpSuit     = gs.powerCard.card.suit;
    // Don't add back to hand — round is over
  }

  const ct = teamOf(gs.currentBidder);
  const ot = otherTeam(ct);
  const rs = { A:0, B:0 };

  // Calling team
  rs[ct] = gs.tricksWon[ct] >= gs.currentBid ? gs.currentBid : -gs.currentBid;
  // Opponent team (fixed target = 5)
  rs[ot] = gs.tricksWon[ot] >= OPP_TARGET   ? OPP_TARGET    : -OPP_TARGET;

  gs.scores.A += rs.A;
  gs.scores.B += rs.B;
  gs.phase     = 'roundEnd';

  const callerWon = gs.tricksWon[ct] >= gs.currentBid;
  const oppWon    = gs.tricksWon[ot] >= OPP_TARGET;
  const msg = [
    callerWon
      ? `Team ${ct} succeeded! ${gs.tricksWon[ct]} tricks (needed ${gs.currentBid}) → +${gs.currentBid}`
      : `Team ${ct} failed! ${gs.tricksWon[ct]} tricks (needed ${gs.currentBid}) → -${gs.currentBid}`,
    oppWon
      ? `Team ${ot} hit target! ${gs.tricksWon[ot]} tricks (target 5) → +5`
      : `Team ${ot} missed target! ${gs.tricksWon[ot]} tricks (target 5) → -5`,
  ].join(' | ');

  // Cache for reconnect
  gs.lastRoundScore = { ...rs };
  gs.lastRoundMsg   = msg;
  gs.lastPowerCard  = gs.powerCard?.card ?? null;

  io.to(room.code).emit('roundEnd',{
    tricksWon:   gs.tricksWon,
    bid:         gs.currentBid,
    bidder:      gs.currentBidder,
    bidderTeam:  ct,
    oppTarget:   OPP_TARGET,
    roundScore:  rs,
    totalScores: gs.scores,
    message:     msg,
    powerCard:   gs.powerCard?.card ?? null,
  });

  if(gs.scores.A >= gs.matchTarget || gs.scores.B >= gs.matchTarget){
    const winner = gs.scores.A >= gs.scores.B ? 'A' : 'B';
    gs.phase = 'gameOver';
    setTimeout(()=>io.to(room.code).emit('gameOver',{ winner, scores: gs.scores }), 3500);
  }
}

// ─────────────────────────────────────────────
//  SOCKET EVENTS
// ─────────────────────────────────────────────
io.on('connection', socket => {
  socket.data = {};

  // ── Create Room ──────────────────────────────
  socket.on('createRoom',({ name, emoji, sessionId })=>{
    if(!name?.trim()) return socket.emit('err','Name required');
    const sid  = sessionId || socket.id;
    const room = createRoom(socket.id, name.trim(), emoji, sid);
    const code = genCode();
    room.code  = code;
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode   = code;
    socket.data.position   = 0;
    socket.data.sessionId  = sid;
    socket.emit('roomCreated',{ code, position:0, players:pi(room), isHost:true, emojis:room.emojis });
  });

  // ── Join Room ────────────────────────────────
  socket.on('joinRoom',({ code, name, emoji, sessionId })=>{
    if(!name?.trim()) return socket.emit('err','Name required');
    const uc   = code?.toUpperCase();
    const room = rooms.get(uc);
    if(!room)  return socket.emit('err','Room not found');
    if(room.players.length >= 4) return socket.emit('err','Room is full');
    if(room.gameState && !['roundEnd','gameOver'].includes(room.gameState.phase))
      return socket.emit('err','Game in progress');

    const sid = sessionId || socket.id;
    const pos = room.players.length;
    room.players.push({ id:socket.id, name:name.trim(), position:pos, sessionId:sid, emoji:emoji||'🎴', online:true });
    room.emojis[pos] = emoji||'🎴';
    socket.join(uc);
    socket.data.roomCode  = uc;
    socket.data.position  = pos;
    socket.data.sessionId = sid;

    socket.emit('roomJoined',{ code:uc, position:pos, players:pi(room), isHost:false, emojis:room.emojis });
    socket.to(uc).emit('playerJoined',{ players:pi(room), emojis:room.emojis });
    if(room.players.length === 4) io.to(uc).emit('allReady',{ players:pi(room), emojis:room.emojis });
  });

  // ── Reconnect ────────────────────────────────
  socket.on('reconnectGame',({ sessionId, roomCode })=>{
    if(!sessionId || !roomCode) return;
    const room = rooms.get(roomCode);
    if(!room) return socket.emit('reconnectFailed',{ reason:'Room not found' });

    const player = playerBySid(room, sessionId);
    if(!player)  return socket.emit('reconnectFailed',{ reason:'Player not found' });

    // Update socket id for this player
    const oldId  = player.id;
    player.id    = socket.id;
    player.online= true;

    socket.join(roomCode);
    socket.data.roomCode  = roomCode;
    socket.data.position  = player.position;
    socket.data.sessionId = sessionId;

    // Update emojis
    room.emojis[player.position] = player.emoji;

    // Notify all that player is back online
    io.to(roomCode).emit('playerReconnected',{
      position: player.position,
      name:     player.name,
      players:  pi(room),
    });

    // Send current game state to reconnected player
    socket.emit('reconnectOk',{
      position: player.position,
      isHost:   room.hostSid === sessionId,
      roomCode,
    });

    sendStateToPlayer(room, player.position);
  });

  // ── Swap Seat ───────────────────────────────
  socket.on('swapSeat',({ targetPos })=>{
    const room = rooms.get(socket.data.roomCode);
    if(!room) return;
    if(room.gameState && !['roundEnd','gameOver'].includes(room.gameState.phase)) return;

    const myPos = socket.data.position;
    if(targetPos === myPos) return;

    const me   = room.players.find(p=>p.id===socket.id);
    const them = room.players.find(p=>p.position===targetPos);
    const myEm = room.emojis[myPos];

    if(them){
      const thEm          = room.emojis[targetPos];
      them.position       = myPos;
      me.position         = targetPos;
      socket.data.position= targetPos;
      room.emojis[myPos]  = thEm;
      room.emojis[targetPos]= myEm;
      const ts = io.sockets.sockets.get(them.id);
      if(ts){ ts.data.position=myPos; ts.emit('yourPosition',{ position:myPos }); }
    } else {
      room.emojis[targetPos]= myEm;
      delete room.emojis[myPos];
      me.position          = targetPos;
      socket.data.position = targetPos;
    }
    socket.emit('yourPosition',{ position:targetPos });
    io.to(room.code).emit('seatsUpdated',{ players:pi(room), emojis:room.emojis });
  });

  // ── Settings ─────────────────────────────────
  socket.on('setTarget',({ target })=>{
    const room = rooms.get(socket.data.roomCode);
    if(!room) return;
    room.settings.matchTarget = target;
    io.to(room.code).emit('targetSet',{ target });
  });

  socket.on('startGame',()=>{
    const room = rooms.get(socket.data.roomCode);
    if(!room || room.players.length !== 4) return;
    // Host = the player at position 0
    const p0 = room.players.find(p=>p.position===0);
    if(!p0 || p0.id !== socket.id) return socket.emit('err','Only Seat 1 can start');
    beginRound(room);
  });

  // ── Discard Initial Hand (no face card) ──────
  socket.on('discardInitialHand',()=>{
    const room = rooms.get(socket.data.roomCode);
    if(!room?.gameState) return;
    const gs  = room.gameState;
    const pos = socket.data.position;

    // Only allowed during calling phase, before any bidding, once per round
    if(gs.phase !== 'calling') return;
    // IMPORTANT: Only the callingStart player (first card receiver) can discard
    if(pos !== gs.callingStart) return socket.emit('err','Only the first card receiver can discard');
    if(gs.callingCount > 0 || gs.currentBid > 0) return socket.emit('err','Cannot discard after bidding has started');
    // No limit on discards — player can keep redrawing until they get a face card/Ace

    const hand = gs.hands[pos];
    // Validate: no face card/Ace in initial 5 (only allowed if hand has 5 cards)
    if(hand.length !== 5) return;
    if(hasFaceCard(hand)) return socket.emit('err','You have a face card or Ace — cannot discard');

    // Mark as discarded
    gs.discardedFlags[pos] = true;
    gs.discardedHands[pos] = [...hand];

    // Put cards back in deck, reshuffle
    gs.deck.push(...hand);
    gs.deck = shuffle(gs.deck);
    gs.hands[pos] = [];

    // Deal 5 new cards to this player
    for(let i=0;i<5&&gs.deck.length>0;i++) gs.hands[pos].push(gs.deck.shift());
    gs.hands[pos] = sortHand(gs.hands[pos]);

    // Tell everyone about the discard
    io.to(room.code).emit('playerDiscarded',{
      pos,
      name: nm(room, pos),
    });

    // Send new hand to player
    const s = sk(room, pos);
    if(s) s.emit('handUpdate',{ hand: gs.hands[pos], dealPhase:'initial', isRedeal:true });
    if(s) s.emit('discardResult',{
      newHand:   gs.hands[pos],
      hasFace:   hasFaceCard(gs.hands[pos]),
    });
  });

  // ── Bidding ──────────────────────────────────
  socket.on('makeBid',({ bid })=>{
    const room = rooms.get(socket.data.roomCode);
    if(!room?.gameState) return;
    const gs  = room.gameState;
    if(gs.phase !== 'calling') return;
    const pos = socket.data.position;
    if(gs.callingTurn !== pos) return;

    const bidNum = parseInt(bid);
    const forced = gs.callingCount===3 && gs.currentBid===0;

    if(bid === 'nil'){
      if(forced) return socket.emit('err','You must bid!');
      io.to(room.code).emit('bidEvent',{ type:'pass', pos, name:nm(room,pos) });
      advanceCalling(room);
    } else if([7,8,9].includes(bidNum) && bidNum > gs.currentBid){
      // Return previous bidder's power card
      if(gs.powerCard){
        gs.hands[gs.currentBidder].push(gs.powerCard.card);
        gs.hands[gs.currentBidder] = sortHand(gs.hands[gs.currentBidder]);
        const ps = sk(room, gs.currentBidder);
        if(ps){ ps.emit('handUpdate',{ hand:gs.hands[gs.currentBidder] }); ps.emit('powerCardReturned',{}); }
        gs.powerCard = null;
      }
      gs.currentBid    = bidNum;
      gs.currentBidder = pos;
      gs.phase         = 'selectingPowerCard';
      io.to(room.code).emit('bidEvent',{ type:'bid', pos, name:nm(room,pos), bid:bidNum });
      socket.emit('selectPowerCard',{ hand:gs.hands[pos] });
    } else {
      socket.emit('err','Invalid bid');
    }
  });

  socket.on('choosePowerCard',({ cardId })=>{
    const room = rooms.get(socket.data.roomCode);
    if(!room?.gameState) return;
    const gs  = room.gameState;
    if(gs.phase !== 'selectingPowerCard') return;
    const pos = socket.data.position;
    if(pos !== gs.currentBidder) return;

    const hand = gs.hands[pos];
    const idx  = hand.findIndex(c=>c.id===cardId);
    if(idx===-1) return socket.emit('err','Invalid card');

    const [card] = hand.splice(idx,1);
    gs.powerCard = { card, position:pos };
    gs.phase     = 'calling';

    socket.emit('handUpdate',{ hand:sortHand(hand) });
    io.to(room.code).emit('powerCardPlaced',{
      bidderPos:  pos,
      bidderName: nm(room,pos),
      bid:        gs.currentBid,
    });
    advanceCalling(room);
  });

  // ── Trump Reveal ─────────────────────────────
  socket.on('revealTrump',()=>{
    const room = rooms.get(socket.data.roomCode);
    if(!room?.gameState) return;
    const gs  = room.gameState;
    if(gs.phase !== 'playing') return;
    const pos = socket.data.position;
    if(gs.currentPlayer !== pos) return;
    if(gs.trumpRevealed || !gs.powerCard || gs.currentTrick.length===0) return;
    const hand = gs.hands[pos];
    if(gs.leadSuit && hand.some(c=>c.suit===gs.leadSuit)) return;

    const revealedCard = gs.powerCard.card;
    const bidderPos    = gs.powerCard.position;
    gs.trumpRevealed   = true;
    gs.trumpSuit       = revealedCard.suit;
    gs.hands[bidderPos].push(revealedCard);
    gs.hands[bidderPos] = sortHand(gs.hands[bidderPos]);
    gs.powerCard = null;

    io.to(room.code).emit('trumpRevealed',{
      trumpSuit:     gs.trumpSuit,
      powerCard:     revealedCard,
      revealedByPos: pos,
      revealedByName:nm(room,pos),
      bidderPos,
    });
    const bs = sk(room, bidderPos);
    if(bs) bs.emit('handUpdate',{ hand:gs.hands[bidderPos] });

    const updatedHand = gs.hands[pos];
    const tc = updatedHand.filter(c=>c.suit===gs.trumpSuit);
    let vids;
    if(tc.length>0){
      const w = trickWin(gs.currentTrick, gs.leadSuit, gs.trumpSuit, true);
      vids = (w!==null && teamOf(w)===teamOf(pos)) ? updatedHand.map(c=>c.id) : tc.map(c=>c.id);
    } else {
      vids = updatedHand.map(c=>c.id);
    }
    socket.emit('yourTurn',{
      validCardIds:  vids,
      leadSuit:      gs.leadSuit,
      trumpSuit:     gs.trumpSuit,
      trumpRevealed: true,
      canRevealTrump:false,
    });
  });

  // ── Play Card ────────────────────────────────
  socket.on('playCard',({ cardId })=>{
    const room = rooms.get(socket.data.roomCode);
    if(!room?.gameState) return;
    const gs  = room.gameState;
    if(gs.phase !== 'playing') return;
    const pos = socket.data.position;
    if(gs.currentPlayer !== pos) return;

    const hand    = gs.hands[pos];
    const cardIdx = hand.findIndex(c=>c.id===cardId);
    if(cardIdx===-1) return socket.emit('err','Card not in hand');
    const card = hand[cardIdx];
    if(!validCards(gs,pos,hand).some(c=>c.id===cardId)) return socket.emit('err','Invalid play');

    hand.splice(cardIdx,1);
    if(gs.currentTrick.length===0) gs.leadSuit = card.suit;
    gs.currentTrick.push({ position:pos, card });

    io.to(room.code).emit('cardPlayed',{
      position:   pos,
      name:       nm(room,pos),
      card,
      trickSoFar: gs.currentTrick,
    });
    socket.emit('handUpdate',{ hand:sortHand(hand) });

    if(gs.currentTrick.length===4) setTimeout(()=>resolveTrick(room), 1500);
    else { gs.currentPlayer=(gs.currentPlayer+1)%4; sendTurn(room, gs.currentPlayer); }
  });

  // ── Ready for Next Round ─────────────────────
  // Uses player position (0-3) — stable across reconnects, never duplicates
  socket.on('readyForNextRound',()=>{
    const room = rooms.get(socket.data.roomCode);
    if(!room?.gameState) return;
    if(room.gameState.phase !== 'roundEnd') return;

    const pos = socket.data.position;
    if(pos === undefined || pos < 0) return;
    room.readySet.add(pos);

    // Count only ONLINE players — offline players are skipped
    const onlineCount = room.players.filter(p => io.sockets.sockets.has(p.id)).length;
    const needed = Math.max(1, onlineCount);  // at least 1

    io.to(room.code).emit('readyCount',{
      ready: room.readySet.size,
      total: needed,
    });

    if(room.readySet.size >= needed){
      room.readySet.clear();
      room.gameState.roundNumber = (room.gameState.roundNumber || 1) + 1;
      beginRound(room);
    }
  });

  // ── Restart ──────────────────────────────────
  socket.on('restartGame',()=>{
    const room = rooms.get(socket.data.roomCode);
    if(!room) return;
    if(socket.data.sessionId !== room.hostSid) return;
    room.gameState = null;
    room.readySet.clear();
    io.to(room.code).emit('gameReset',{ players:pi(room) });
  });

  // ── Disconnect ───────────────────────────────
  socket.on('kickPlayer',({targetPos})=>{
    const room=rooms.get(socket.data.roomCode);if(!room)return;
    if(socket.data.sessionId!==room.hostSid)return socket.emit('err','Only host can kick');
    if(room.gameState&&!['roundEnd','gameOver'].includes(room.gameState.phase))
      return socket.emit('err','Cannot kick during game');
    const target=room.players.find(p=>p.position===targetPos);
    if(!target||target.sessionId===room.hostSid)return;
    const ts=io.sockets.sockets.get(target.id);
    if(ts){ts.emit('kicked',{});ts.leave(room.code);}
    // Remove from players list, shift positions
    room.players=room.players.filter(p=>p.position!==targetPos);
    // Re-assign positions sequentially
    room.players.forEach((p,i)=>{
      const oldPos=p.position;p.position=i;
      room.emojis[i]=room.emojis[oldPos];
      const ps=io.sockets.sockets.get(p.id);
      if(ps){ps.data.position=i;if(oldPos!==i)ps.emit('yourPosition',{position:i});}
    });
    // Clean up extra emoji keys
    Object.keys(room.emojis).forEach(k=>{if(parseInt(k)>=room.players.length)delete room.emojis[k];});
    io.to(room.code).emit('seatsUpdated',{players:pi(room),emojis:room.emojis});
    io.to(room.code).emit('playerKicked',{name:target.name});
  });

  socket.on('disconnect',()=>{
    const { roomCode, position, sessionId } = socket.data;
    if(!roomCode) return;
    const room = rooms.get(roomCode);
    if(!room)    return;

    const player = room.players.find(p=>p.id===socket.id);
    if(player){
      player.online = false;   // Mark offline but keep slot
      io.to(roomCode).emit('playerLeft',{
        name:     player.name,
        position: player.position,
        players:  pi(room),
      });
    }

    // Only delete room if ALL players have been offline for a while
    // Give 5 minutes for reconnect before room cleanup
    setTimeout(()=>{
      const r = rooms.get(roomCode);
      if(!r) return;
      const allOffline = r.players.every(p=>!io.sockets.sockets.has(p.id));
      if(allOffline) rooms.delete(roomCode);
    }, 5 * 60 * 1000);
  });
});

// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log(`🃏 Italy → http://localhost:${PORT}`));
