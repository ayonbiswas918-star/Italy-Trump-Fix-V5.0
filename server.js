/**
 * Italy Card Game — Server v5
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = ['spades','hearts','diamonds','clubs'];
const RANK_VAL = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

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
const teamOf=p=>p%2===0?'A':'B';
const otherTeam=t=>t==='A'?'B':'A';
function sortHand(h){
  const so={spades:0,hearts:1,diamonds:2,clubs:3};
  return [...h].sort((a,b)=>a.suit!==b.suit?so[a.suit]-so[b.suit]:RANK_VAL[b.rank]-RANK_VAL[a.rank]);
}
function cardBeats(ch,cur,lead,trump,rev){
  const ct=rev&&ch.suit===trump,wt=rev&&cur.suit===trump;
  if(ct&&!wt)return true;if(!ct&&wt)return false;
  if(ct&&wt)return RANK_VAL[ch.rank]>RANK_VAL[cur.rank];
  if(ch.suit===lead&&cur.suit!==lead)return true;
  if(ch.suit!==lead&&cur.suit===lead)return false;
  if(ch.suit===lead)return RANK_VAL[ch.rank]>RANK_VAL[cur.rank];
  return false;
}

const rooms=new Map();

function createRoom(id,name,emoji){
  return{code:null,hostId:id,players:[{id,name,position:0}],
    emojis:{0:emoji||'🎴'},settings:{matchTarget:30},gameState:null,readySet:new Set()};
}

function freshState(prev,target){
  const dealerPos=prev?(prev.dealerPos+1)%4:0;
  const callingStart=(dealerPos+1)%4;
  return{phase:'calling',deck:[],hands:{0:[],1:[],2:[],3:[]},
    powerCard:null,trumpSuit:null,trumpRevealed:false,
    currentBid:0,currentBidder:-1,dealerPos,callingStart,
    callingTurn:callingStart,callingCount:0,currentPlayer:callingStart,
    currentTrick:[],leadSuit:null,tricksWon:{A:0,B:0},
    scores:prev?{...prev.scores}:{A:0,B:0},matchTarget:target,
    roundNumber:prev?prev.roundNumber:1,trickNumber:1};
}

const nm=(room,pos)=>room.players.find(p=>p.position===pos)?.name||`P${pos+1}`;
const sk=(room,pos)=>{const p=room.players.find(pl=>pl.position===pos);return p?io.sockets.sockets.get(p.id):null;};
const pi=room=>room.players.map(p=>({id:p.id,name:p.name,position:p.position,team:teamOf(p.position)}));

function validCards(gs,pos,hand){
  if(gs.currentTrick.length===0)return hand;
  const lead=hand.filter(c=>c.suit===gs.leadSuit);
  if(lead.length>0)return lead;
  if(gs.trumpRevealed){
    const tc=hand.filter(c=>c.suit===gs.trumpSuit);
    if(tc.length>0){
      const w=trickWin(gs.currentTrick,gs.leadSuit,gs.trumpSuit,true);
      if(w!==null&&teamOf(w)===teamOf(pos))return hand;
      return tc;
    }
  }
  return hand;
}
function trickWin(trick,lead,trump,rev){
  if(!trick.length)return null;
  let w=trick[0];
  for(let i=1;i<trick.length;i++)if(cardBeats(trick[i].card,w.card,lead,trump,rev))w=trick[i];
  return w.position;
}
function canReveal(gs,pos,hand){
  if(gs.trumpRevealed||!gs.powerCard||gs.currentTrick.length===0)return false;
  return gs.leadSuit?!hand.some(c=>c.suit===gs.leadSuit):false;
}

function beginRound(room){
  const gs=freshState(room.gameState,room.settings.matchTarget);
  room.gameState=gs;room.readySet.clear();
  gs.deck=shuffle(createDeck());
  for(let i=0;i<5;i++)for(let o=1;o<=4;o++)gs.hands[(gs.dealerPos+o)%4].push(gs.deck.shift());
  for(let p=0;p<4;p++)gs.hands[p]=sortHand(gs.hands[p]);
  gs.phase='calling';
  io.to(room.code).emit('roundBegin',{
    roundNumber:gs.roundNumber,scores:gs.scores,players:pi(room),
    matchTarget:gs.matchTarget,dealerPos:gs.dealerPos,
    dealerName:nm(room,gs.dealerPos),firstActiveName:nm(room,gs.callingStart),
    firstActivePos:gs.callingStart,emojis:room.emojis});
  room.players.forEach(p=>{const s=sk(room,p.position);if(s)s.emit('handUpdate',{hand:gs.hands[p.position],dealPhase:'initial'});});
  setTimeout(()=>startCalling(room),800);
}

function startCalling(room){
  const gs=room.gameState;
  io.to(room.code).emit('callingStarted',{callerPos:gs.callingStart,callerName:nm(room,gs.callingStart),currentBid:0});
  promptCaller(room,gs.callingStart,0,true);
}
function promptCaller(room,pos,bid,canPass){
  const s=sk(room,pos);
  if(s)s.emit('yourCallingTurn',{currentBid:bid,canPass,hand:room.gameState.hands[pos]});
}
function advanceCalling(room){
  const gs=room.gameState;gs.callingCount++;
  if(gs.callingCount>=4){
    if(gs.currentBid===0){gs.currentBid=7;gs.currentBidder=gs.dealerPos;}
    io.to(room.code).emit('callingDone',{bidder:gs.currentBidder,bidderName:nm(room,gs.currentBidder),bid:gs.currentBid});
    setTimeout(()=>dealRest(room),1000);return;
  }
  gs.callingTurn=(gs.callingStart+gs.callingCount)%4;
  const forced=gs.callingCount===3&&gs.currentBid===0;
  io.to(room.code).emit('callingTurn',{callerPos:gs.callingTurn,callerName:nm(room,gs.callingTurn),currentBid:gs.currentBid,canPass:!forced});
  promptCaller(room,gs.callingTurn,gs.currentBid,!forced);
}
function dealRest(room){
  const gs=room.gameState;gs.phase='dealing2';
  for(let r=0;r<2;r++)for(let o=1;o<=4;o++){const p=(gs.dealerPos+o)%4;for(let i=0;i<4&&gs.deck.length;i++)gs.hands[p].push(gs.deck.shift());}
  for(let p=0;p<4;p++)gs.hands[p]=sortHand(gs.hands[p]);
  room.players.forEach(p=>{const s=sk(room,p.position);if(s)s.emit('fullHandDealt',{hand:gs.hands[p.position],bidder:gs.currentBidder,bid:gs.currentBid,powerCardSuit:p.position===gs.currentBidder?(gs.powerCard?.card?.suit??null):null});});
  io.to(room.code).emit('dealingComplete',{bidder:gs.currentBidder,bidderName:nm(room,gs.currentBidder),bid:gs.currentBid});
  setTimeout(()=>startPlay(room),1200);
}
function startPlay(room){
  const gs=room.gameState;gs.phase='playing';gs.currentPlayer=gs.callingStart;gs.trickNumber=1;
  io.to(room.code).emit('playingStarted',{currentPlayer:gs.currentPlayer,currentPlayerName:nm(room,gs.currentPlayer),trickNumber:1});
  sendTurn(room,gs.currentPlayer);
}
function sendTurn(room,pos){
  const gs=room.gameState;
  let hand=gs.hands[pos];

  // Auto-return power card if bidder's hand is empty (trump never revealed, last trick)
  if(hand.length===0 && gs.powerCard && gs.powerCard.position===pos){
    const card=gs.powerCard.card;
    gs.hands[pos].push(card);
    gs.hands[pos]=sortHand(gs.hands[pos]);
    gs.trumpRevealed=true;
    gs.trumpSuit=card.suit;
    gs.powerCard=null;
    hand=gs.hands[pos];
    io.to(room.code).emit('trumpRevealed',{trumpSuit:gs.trumpSuit,powerCard:card,
      revealedByPos:pos,revealedByName:nm(room,pos),bidderPos:pos,autoReveal:true});
    const bs=sk(room,pos);
    if(bs)bs.emit('handUpdate',{hand});
  }

  const vids=validCards(gs,pos,hand).map(c=>c.id);
  const cr=canReveal(gs,pos,hand);
  io.to(room.code).emit('turnChanged',{currentPlayer:pos,currentPlayerName:nm(room,pos)});
  const s=sk(room,pos);
  if(s)s.emit('yourTurn',{validCardIds:vids,leadSuit:gs.leadSuit,trumpSuit:gs.trumpRevealed?gs.trumpSuit:null,trumpRevealed:gs.trumpRevealed,canRevealTrump:cr});
}
function resolveTrick(room){
  const gs=room.gameState;
  let w=gs.currentTrick[0];
  for(let i=1;i<gs.currentTrick.length;i++)if(cardBeats(gs.currentTrick[i].card,w.card,gs.leadSuit,gs.trumpSuit,gs.trumpRevealed))w=gs.currentTrick[i];
  const wt=teamOf(w.position);gs.tricksWon[wt]++;
  const total=gs.tricksWon.A+gs.tricksWon.B;
  io.to(room.code).emit('trickComplete',{winnerPos:w.position,winnerName:nm(room,w.position),winnerTeam:wt,trickCards:gs.currentTrick,tricksWon:gs.tricksWon,trickNumber:gs.trickNumber});
  gs.currentTrick=[];gs.leadSuit=null;gs.trickNumber++;
  if(total>=13){setTimeout(()=>endRound(room),2000);}
  else{gs.currentPlayer=w.position;setTimeout(()=>{io.to(room.code).emit('newTrickStarting',{trickNumber:gs.trickNumber,leader:gs.currentPlayer,leaderName:nm(room,gs.currentPlayer)});sendTurn(room,gs.currentPlayer);},2000);}
}
function endRound(room){
  const gs=room.gameState,ct=teamOf(gs.currentBidder),ot=otherTeam(ct),rs={A:0,B:0};
  if(gs.tricksWon[ct]>=gs.currentBid){rs[ct]=gs.currentBid;}
  else{rs[ct]=-gs.currentBid;rs[ot]=Math.max(0,gs.tricksWon[ot]-5);}
  gs.scores.A+=rs.A;gs.scores.B+=rs.B;gs.phase='roundEnd';
  const msg=gs.tricksWon[ct]>=gs.currentBid
    ?`Team ${ct} succeeded! Won ${gs.tricksWon[ct]} tricks (needed ${gs.currentBid}).`
    :`Team ${ct} failed! Won only ${gs.tricksWon[ct]} tricks (needed ${gs.currentBid}).`;
  io.to(room.code).emit('roundEnd',{tricksWon:gs.tricksWon,bid:gs.currentBid,bidder:gs.currentBidder,bidderTeam:ct,roundScore:rs,totalScores:gs.scores,message:msg,powerCard:gs.powerCard?.card??null});
  if(gs.scores.A>=gs.matchTarget||gs.scores.B>=gs.matchTarget){
    const winner=gs.scores.A>=gs.matchTarget?'A':'B';gs.phase='gameOver';
    setTimeout(()=>io.to(room.code).emit('gameOver',{winner,scores:gs.scores}),3500);
  }
}

io.on('connection',socket=>{
  socket.data={};

  socket.on('createRoom',({name,emoji})=>{
    if(!name?.trim())return socket.emit('err','Name required');
    const room=createRoom(socket.id,name.trim(),emoji);
    const code=genCode();room.code=code;rooms.set(code,room);
    socket.join(code);socket.data.roomCode=code;socket.data.position=0;
    socket.emit('roomCreated',{code,position:0,players:pi(room),isHost:true,emojis:room.emojis});
  });

  socket.on('joinRoom',({code,name,emoji})=>{
    if(!name?.trim())return socket.emit('err','Name required');
    const uc=code?.toUpperCase(),room=rooms.get(uc);
    if(!room)return socket.emit('err','Room not found');
    if(room.players.length>=4)return socket.emit('err','Room is full');
    if(room.gameState&&!['roundEnd','gameOver'].includes(room.gameState.phase))return socket.emit('err','Game in progress');
    const pos=room.players.length;
    room.players.push({id:socket.id,name:name.trim(),position:pos});
    room.emojis[pos]=emoji||'🎴';
    socket.join(uc);socket.data.roomCode=uc;socket.data.position=pos;
    socket.emit('roomJoined',{code:uc,position:pos,players:pi(room),isHost:false,emojis:room.emojis});
    socket.to(uc).emit('playerJoined',{players:pi(room),emojis:room.emojis});
    if(room.players.length===4)io.to(uc).emit('allReady',{players:pi(room),emojis:room.emojis});
  });

  socket.on('swapSeat',({targetPos})=>{
    const room=rooms.get(socket.data.roomCode);if(!room)return;
    if(room.gameState&&!['roundEnd','gameOver'].includes(room.gameState.phase))return;
    const myPos=socket.data.position;if(targetPos===myPos)return;
    const me=room.players.find(p=>p.id===socket.id);
    const them=room.players.find(p=>p.position===targetPos);
    const myEmoji=room.emojis[myPos];
    if(them){
      const theirEmoji=room.emojis[targetPos];
      them.position=myPos;me.position=targetPos;
      socket.data.position=targetPos;
      room.emojis[myPos]=theirEmoji;room.emojis[targetPos]=myEmoji;
      const ts=io.sockets.sockets.get(them.id);
      if(ts){ts.data.position=myPos;ts.emit('yourPosition',{position:myPos});}
    }else{
      room.emojis[targetPos]=myEmoji;delete room.emojis[myPos];
      me.position=targetPos;socket.data.position=targetPos;
    }
    socket.emit('yourPosition',{position:targetPos});
    io.to(room.code).emit('seatsUpdated',{players:pi(room),emojis:room.emojis});
  });

  socket.on('setTarget',({target})=>{
    const room=rooms.get(socket.data.roomCode);if(!room)return;
    room.settings.matchTarget=target;io.to(room.code).emit('targetSet',{target});
  });

  socket.on('startGame',()=>{
    const room=rooms.get(socket.data.roomCode);
    if(!room||room.players.length!==4)return;
    if(socket.id!==room.hostId)return socket.emit('err','Only the host can start');
    beginRound(room);
  });

  socket.on('makeBid',({bid})=>{
    const room=rooms.get(socket.data.roomCode);if(!room?.gameState)return;
    const gs=room.gameState;if(gs.phase!=='calling')return;
    const pos=socket.data.position;if(gs.callingTurn!==pos)return;
    const bidNum=parseInt(bid),forced=gs.callingCount===3&&gs.currentBid===0;
    if(bid==='nil'){
      if(forced)return socket.emit('err','You must bid!');
      io.to(room.code).emit('bidEvent',{type:'pass',pos,name:nm(room,pos)});
      advanceCalling(room);
    }else if([7,8,9].includes(bidNum)&&bidNum>gs.currentBid){
      if(gs.powerCard){
        gs.hands[gs.currentBidder].push(gs.powerCard.card);
        gs.hands[gs.currentBidder]=sortHand(gs.hands[gs.currentBidder]);
        const ps=sk(room,gs.currentBidder);
        if(ps){ps.emit('handUpdate',{hand:gs.hands[gs.currentBidder]});ps.emit('powerCardReturned',{});}
        gs.powerCard=null;
      }
      gs.currentBid=bidNum;gs.currentBidder=pos;gs.phase='selectingPowerCard';
      io.to(room.code).emit('bidEvent',{type:'bid',pos,name:nm(room,pos),bid:bidNum});
      socket.emit('selectPowerCard',{hand:gs.hands[pos]});
    }else socket.emit('err','Invalid bid');
  });

  socket.on('choosePowerCard',({cardId})=>{
    const room=rooms.get(socket.data.roomCode);if(!room?.gameState)return;
    const gs=room.gameState;if(gs.phase!=='selectingPowerCard')return;
    const pos=socket.data.position;if(pos!==gs.currentBidder)return;
    const hand=gs.hands[pos],idx=hand.findIndex(c=>c.id===cardId);
    if(idx===-1)return socket.emit('err','Invalid card');
    const[card]=hand.splice(idx,1);
    gs.powerCard={card,position:pos};gs.phase='calling';
    socket.emit('handUpdate',{hand:sortHand(hand)});
    io.to(room.code).emit('powerCardPlaced',{bidderPos:pos,bidderName:nm(room,pos),bid:gs.currentBid});
    advanceCalling(room);
  });

  socket.on('revealTrump',()=>{
    const room=rooms.get(socket.data.roomCode);if(!room?.gameState)return;
    const gs=room.gameState;if(gs.phase!=='playing')return;
    const pos=socket.data.position;if(gs.currentPlayer!==pos)return;
    if(gs.trumpRevealed||!gs.powerCard||gs.currentTrick.length===0)return;
    const hand=gs.hands[pos];
    if(gs.leadSuit&&hand.some(c=>c.suit===gs.leadSuit))return;

    // ── Reveal trump ──
    const revealedCard=gs.powerCard.card;
    const bidderPos=gs.powerCard.position;
    gs.trumpRevealed=true;
    gs.trumpSuit=revealedCard.suit;

    // ── Return power card to bidder's hand ──
    gs.hands[bidderPos].push(revealedCard);
    gs.hands[bidderPos]=sortHand(gs.hands[bidderPos]);
    gs.powerCard=null;  // clear power card slot

    // Broadcast reveal with updated hand count for bidder
    io.to(room.code).emit('trumpRevealed',{
      trumpSuit:gs.trumpSuit,
      powerCard:revealedCard,
      revealedByPos:pos,
      revealedByName:nm(room,pos),
      bidderPos,   // so clients can update bidder's card count
    });

    // Send updated hand to the bidder
    const bidderSock=sk(room,bidderPos);
    if(bidderSock){
      bidderSock.emit('handUpdate',{hand:gs.hands[bidderPos]});
    }

    // Now recalculate valid cards for the current player (hand may have changed if pos===bidderPos)
    const updatedHand=gs.hands[pos];
    const tc=updatedHand.filter(c=>c.suit===gs.trumpSuit);
    let vids;
    if(tc.length>0){
      const w=trickWin(gs.currentTrick,gs.leadSuit,gs.trumpSuit,true);
      vids=(w!==null&&teamOf(w)===teamOf(pos))?updatedHand.map(c=>c.id):tc.map(c=>c.id);
    }else{
      vids=updatedHand.map(c=>c.id);
    }
    socket.emit('yourTurn',{validCardIds:vids,leadSuit:gs.leadSuit,trumpSuit:gs.trumpSuit,trumpRevealed:true,canRevealTrump:false});
  });

  socket.on('playCard',({cardId})=>{
    const room=rooms.get(socket.data.roomCode);if(!room?.gameState)return;
    const gs=room.gameState;if(gs.phase!=='playing')return;
    const pos=socket.data.position;if(gs.currentPlayer!==pos)return;
    const hand=gs.hands[pos],idx=hand.findIndex(c=>c.id===cardId);
    if(idx===-1)return socket.emit('err','Card not in hand');
    const card=hand[idx];
    if(!validCards(gs,pos,hand).some(c=>c.id===cardId))return socket.emit('err','Invalid play');
    hand.splice(idx,1);
    if(gs.currentTrick.length===0)gs.leadSuit=card.suit;
    gs.currentTrick.push({position:pos,card});
    io.to(room.code).emit('cardPlayed',{position:pos,name:nm(room,pos),card,trickSoFar:gs.currentTrick});
    socket.emit('handUpdate',{hand:sortHand(hand)});
    if(gs.currentTrick.length===4)setTimeout(()=>resolveTrick(room),1500);
    else{gs.currentPlayer=(gs.currentPlayer+1)%4;sendTurn(room,gs.currentPlayer);}
  });

  socket.on('readyForNextRound',()=>{
    const room=rooms.get(socket.data.roomCode);
    if(!room?.gameState||room.gameState.phase!=='roundEnd')return;
    room.readySet.add(socket.id);
    io.to(room.code).emit('readyCount',{ready:room.readySet.size,total:room.players.length});
    if(room.readySet.size>=room.players.length){room.readySet.clear();room.gameState.roundNumber++;beginRound(room);}
  });

  socket.on('restartGame',()=>{
    const room=rooms.get(socket.data.roomCode);if(!room)return;
    if(socket.id!==room.hostId)return;
    room.gameState=null;room.readySet.clear();
    io.to(room.code).emit('gameReset',{players:pi(room)});
  });

  socket.on('disconnect',()=>{
    const{roomCode,position}=socket.data;if(!roomCode)return;
    const room=rooms.get(roomCode);if(!room)return;
    const pi2=room.players.findIndex(p=>p.id===socket.id);
    if(pi2!==-1)io.to(roomCode).emit('playerLeft',{name:room.players[pi2].name,position});
    if(!room.players.some(p=>io.sockets.sockets.has(p.id)))rooms.delete(roomCode);
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`🃏 Italy → http://localhost:${PORT}`));
