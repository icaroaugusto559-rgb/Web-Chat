/**
 * Teste da camada de persistencia (db.js).
 * Roda contra um SQLite real em arquivo temporario.
 *
 *   npm run test:db
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-db-'));
const file = path.join(tmpDir, 'test.db');
const sql = db.openDb(file);

const mkUser = (name) => db.resolveUser(sql, { name, token: null });
const mkRoom = (code, opts = {}) => db.createRoom(sql)({
  code,
  name: opts.name || `Sala ${code}`,
  description: opts.description || '',
  isPrivate: Boolean(opts.isPrivate),
  avatarPath: opts.avatarPath || null,
  user: opts.user || mkUser(`dono-${code}`),
});

function main() {
  console.log('\n[1] schema');
  const tables = sql.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  ['rooms', 'retired_codes', 'users', 'memberships', 'requests', 'messages']
    .forEach((t) => check(`tabela ${t} existe`, tables.includes(t), tables.join(',')));
  check('WAL ativo', sql.pragma('journal_mode', { simple: true }) === 'wal');

  console.log('\n[2] usuarios e token de sessao');
  const ana = mkUser('Ana');
  check('usuario criado com token', Boolean(ana.token) && ana.token.length >= 32);
  const same = db.resolveUser(sql, { name: 'Ana', token: ana.token });
  check('mesmo token devolve o MESMO usuario', same.id === ana.id, `${same.id} vs ${ana.id}`);
  const renamed = db.resolveUser(sql, { name: 'Ana Silva', token: ana.token });
  check('token conhecido atualiza o nome sem criar outro usuario',
    renamed.id === ana.id && renamed.name === 'Ana Silva', JSON.stringify(renamed));
  const other = db.resolveUser(sql, { name: 'Ana', token: 'token-inexistente' });
  check('token desconhecido cria usuario novo', other.id !== ana.id);

  console.log('\n[3] codigo unico (o requisito central)');
  const r1 = mkRoom('33p');
  check('cria sala com codigo escolhido', r1.ok === true && r1.code === '33p', JSON.stringify(r1));
  const dup = mkRoom('33p', { user: mkUser('outra') });
  check('codigo repetido e RECUSADO', dup.ok === false && dup.error === 'code_taken', JSON.stringify(dup));
  const upper = mkRoom('33P', { user: mkUser('outra2') });
  check('maiuscula nao burla a unicidade', upper.ok === false && upper.error === 'code_taken', JSON.stringify(upper));
  const spaces = mkRoom('  3 3 p  ', { user: mkUser('outra3') });
  check('espacos sao removidos antes de comparar', spaces.ok === false && spaces.error === 'code_taken', JSON.stringify(spaces));
  const short = mkRoom('ab');
  check('codigo curto demais e recusado', short.ok === false && /pelo menos/.test(short.error || ''), JSON.stringify(short));
  const retired = sql.prepare('SELECT COUNT(*) c FROM retired_codes').get().c;
  check('codigo fica registrado em retired_codes', retired >= 1, String(retired));

  console.log('\n[4] codigo nunca e reaproveitado, nem apos apagar a sala');
  const doomed = mkRoom('zzz9', { user: mkUser('dono-zzz') });
  check('sala zzz9 criada', doomed.ok === true);
  sql.prepare('DELETE FROM rooms WHERE code = ?').run('zzz9');
  check('sala apagada do banco', db.getRoomByCode(sql, 'zzz9') === undefined);
  const reuse = mkRoom('zzz9', { user: mkUser('novo-dono') });
  check('codigo de sala apagada NAO pode ser usado de novo', reuse.ok === false && reuse.error === 'code_taken', JSON.stringify(reuse));

  console.log('\n[5] geracao automatica de codigo');
  const generated = new Set();
  for (let i = 0; i < 500; i += 1) generated.add(db.generateUniqueCode(sql, 5));
  check('500 codigos gerados sem colisao', generated.size === 500, String(generated.size));
  check('todos tem 5 chars de [a-z0-9]', [...generated].every((c) => /^[a-z0-9]{5}$/.test(c)));
  check('todos ficaram reservados em retired_codes',
    sql.prepare('SELECT COUNT(*) c FROM retired_codes').get().c >= 500);
  const taken = db.reserveCode(sql, '33p');
  check('reserveCode recusa codigo ja em uso', taken.ok === false && taken.error === 'code_taken', JSON.stringify(taken));

  // REGRESSAO: este e exatamente o fluxo da tela de criar sala — a pessoa clica
  // em "gerar codigo" (que reserva o codigo) e depois confirma a criacao com
  // esse mesmo codigo. Antes o segundo passo era recusado como "code_taken".
  const dono = mkUser('Gerador');
  const gerado = db.generateUniqueCode(sql, 5);
  const comGerado = mkRoom(gerado, { user: dono, name: 'Sala gerada' });
  check('codigo gerado pelo botao pode ser usado para criar a sala',
    comGerado.ok === true && comGerado.code === gerado, JSON.stringify(comGerado));
  const comGeradoDeNovo = mkRoom(gerado, { user: mkUser('Esperto') });
  check('mas continua recusando duplicata depois disso',
    comGeradoDeNovo.ok === false && comGeradoDeNovo.error === 'code_taken', JSON.stringify(comGeradoDeNovo));

  console.log('\n[6] entrar em sala publica');
  const pub = mkRoom('pub1');
  const bia = mkUser('Bia');
  const joinPub = db.joinRoom(sql)({ roomId: pub.roomId, userId: bia.id });
  check('sala publica: entra direto', joinPub.ok === true && joinPub.joined === true, JSON.stringify(joinPub));
  check('sala publica: vira membro comum', joinPub.role === 'member');
  check('membro aparece na lista', db.listMembers(sql, pub.roomId).some((m) => m.name === 'Bia'));
  const again = db.joinRoom(sql)({ roomId: pub.roomId, userId: bia.id });
  check('entrar de novo nao duplica membership', again.ok === true && again.joined === true);
  check('continuam 2 membros', db.listMembers(sql, pub.roomId).length === 2, String(db.listMembers(sql, pub.roomId).length));

  console.log('\n[7] sala privada: pedido e aprovacao');
  const owner = mkUser('Carol');
  const priv = mkRoom('priv1', { isPrivate: true, user: owner });
  const dave = mkUser('Dave');

  const ask = db.joinRoom(sql)({ roomId: priv.roomId, userId: dave.id });
  check('sala privada: NAO entra na hora', ask.ok === true && ask.joined === false && ask.pending === true, JSON.stringify(ask));
  check('nao virou membro', db.listMembers(sql, priv.roomId).every((m) => m.id !== dave.id));
  check('pedido criado como pendente', db.countPending(sql, priv.roomId) === 1);
  check('pedido aparece na lista', db.listPendingRequests(sql, priv.roomId)[0].name === 'Dave');

  const askAgain = db.joinRoom(sql)({ roomId: priv.roomId, userId: dave.id });
  check('pedir de novo nao duplica o pedido', askAgain.duplicate === true && db.countPending(sql, priv.roomId) === 1, JSON.stringify(askAgain));

  const asMember = db.decideRequest(sql)({ requestId: ask.requestId, adminUserId: dave.id, approve: true });
  check('quem nao e admin NAO pode aprovar', asMember.ok === false && asMember.error === 'forbidden', JSON.stringify(asMember));
  check('pedido continua pendente apos tentativa invalida', db.countPending(sql, priv.roomId) === 1);

  const approved = db.decideRequest(sql)({ requestId: ask.requestId, adminUserId: owner.id, approve: true });
  check('admin aprova o pedido', approved.ok === true && approved.approved === true, JSON.stringify(approved));
  check('aprovado virou membro', Boolean(db.getMembership(sql, priv.roomId, dave.id)));
  check('papel continua "member" (nao admin)', db.getMembership(sql, priv.roomId, dave.id).role === 'member');
  check('nao ha mais pedidos pendentes', db.countPending(sql, priv.roomId) === 0);

  const twice = db.decideRequest(sql)({ requestId: ask.requestId, adminUserId: owner.id, approve: true });
  check('decidir duas vezes e recusado', twice.ok === false && /ja foi decidido/.test(twice.error || ''), JSON.stringify(twice));

  const missing = db.decideRequest(sql)({ requestId: 999999, adminUserId: owner.id, approve: true });
  check('pedido inexistente e recusado', missing.ok === false);

  console.log('\n[8] pedido recusado nao pode ser refeito');
  const erin = mkUser('Erin');
  const ask2 = db.joinRoom(sql)({ roomId: priv.roomId, userId: erin.id });
  check('Erin pede entrada', ask2.pending === true);
  const rejected = db.decideRequest(sql)({ requestId: ask2.requestId, adminUserId: owner.id, approve: false });
  check('admin recusa', rejected.ok === true && rejected.approved === false);
  check('Erin nao virou membro', db.getMembership(sql, priv.roomId, erin.id) === undefined);
  const retry = db.joinRoom(sql)({ roomId: priv.roomId, userId: erin.id });
  check('recusado nao consegue pedir de novo', retry.ok === false && retry.error === 'rejected_before', JSON.stringify(retry));

  console.log('\n[9] criador e admin');
  const members = db.listMembers(sql, priv.roomId);
  check('criador tem papel admin', members.find((m) => m.name === 'Carol')?.role === 'admin');
  check('aprovado tem papel member', members.find((m) => m.name === 'Dave')?.role === 'member');

  console.log('\n[10] mensagens: seq, dedup e paginacao');
  const a1 = db.appendMessage(sql, { roomId: priv.roomId, author: 'Carol', authorId: owner.id, text: 'oi', clientId: 'c1' });
  check('primeira mensagem tem seq 1', a1.message.seq === 1, String(a1.message.seq));
  const a2 = db.appendMessage(sql, { roomId: priv.roomId, author: 'Dave', authorId: dave.id, text: 'ola', clientId: 'c2' });
  const a3 = db.appendMessage(sql, { roomId: priv.roomId, author: 'Carol', authorId: owner.id, text: 'tudo bem?', clientId: 'c3' });
  check('seq cresce a cada mensagem', a2.message.seq === 2 && a3.message.seq === 3, `${a2.message.seq},${a3.message.seq}`);
  const dupMsg = db.appendMessage(sql, { roomId: priv.roomId, author: 'Carol', authorId: owner.id, text: 'oi', clientId: 'c1' });
  check('mesmo clientId devolve a MESMA mensagem', dupMsg.duplicate === true && dupMsg.message.id === a1.message.id, JSON.stringify(dupMsg));
  check('dedup nao criou linha extra', db.listMessages(sql, priv.roomId).length === 3, String(db.listMessages(sql, priv.roomId).length));

  for (let i = 0; i < 60; i += 1) {
    db.appendMessage(sql, { roomId: priv.roomId, author: 'Carol', authorId: owner.id, text: `msg ${i}` });
  }
  const page1 = db.listMessages(sql, priv.roomId, { limit: 50 });
  check('pagina devolve no maximo 50', page1.length === 50, String(page1.length));
  check('pagina vem em ordem crescente de seq', page1.every((m, i, arr) => i === 0 || m.seq >= arr[i - 1].seq));
  const page2 = db.listMessages(sql, priv.roomId, { beforeSeq: page1[0].seq, limit: 50 });
  check('cursor beforeSeq traz mensagens mais antigas', page2.every((m) => m.seq < page1[0].seq));
  check('total persistido = 63', db.listMessages(sql, priv.roomId, { limit: 500 }).length === 63, String(db.listMessages(sql, priv.roomId, { limit: 500 }).length));

  console.log('\n[11] seq e independente por sala');
  const outraSala = mkRoom('outra1');
  const b1 = db.appendMessage(sql, { roomId: outraSala.roomId, author: 'X', text: 'oi' });
  check('outra sala comeca em seq 1 de novo', b1.message.seq === 1, String(b1.message.seq));
  check('mensagens nao vazam entre salas', db.listMessages(sql, outraSala.roomId).length === 1);

  console.log('\n[12] profile da sala (tela de banner)');
  const withAvatar = mkRoom('ava1', { avatarPath: 'ava1-abc.jpg', name: 'Galera', description: 'Papo bom', user: mkUser('Fofo') });
  const profile = db.roomProfile(sql, 'ava1');
  check('profile traz nome', profile.name === 'Galera');
  check('profile traz descricao', profile.description === 'Papo bom');
  check('profile monta a URL do avatar', profile.avatarUrl === '/uploads/ava1-abc.jpg', String(profile.avatarUrl));
  check('profile traz o criador', profile.creatorName === 'Fofo');
  check('profile conta membros', profile.members === 1);
  check('profile sinaliza sala privada', db.roomProfile(sql, 'priv1').isPrivate === true);
  check('profile sinaliza sala publica', profile.isPrivate === false);
  check('profile de sala inexistente e null', db.roomProfile(sql, 'naoexiste') === null);
  check('profile normaliza maiuscula na busca', db.roomProfile(sql, 'AVA1').code === 'ava1');

  console.log('\n[13] normalizacao de codigo');
  check('"AbC123" -> "abc123"', db.normalizeCode('AbC123') === 'abc123');
  check('remove espacos e simbolos', db.normalizeCode('  #Sa la!@# 01 ') === 'sala01');
  check('trunca para 24 chars', db.normalizeCode('x'.repeat(200)).length === 24);
  check('vazio continua vazio', db.normalizeCode(null) === '');

  console.log('\n[14] papeis: promover e rebaixar');
  const boss = mkUser('Chefe');
  const team = mkRoom('time1', { user: boss });
  const mem1 = mkUser('Um');
  const mem2 = mkUser('Dois');
  db.joinRoom(sql)({ roomId: team.roomId, userId: mem1.id });
  db.joinRoom(sql)({ roomId: team.roomId, userId: mem2.id });

  const promote = db.setRole(sql)({ roomId: team.roomId, targetUserId: mem1.id, actorUserId: boss.id, role: 'admin' });
  check('admin promove membro a admin', promote.ok === true && promote.role === 'admin', JSON.stringify(promote));
  check('papel gravado no banco', db.getMembership(sql, team.roomId, mem1.id).role === 'admin');
  check('isAdmin reconhece o promovido', db.isAdmin(sql, team.roomId, mem1.id) === true);
  check('isAdmin nega para membro comum', db.isAdmin(sql, team.roomId, mem2.id) === false);

  const demote = db.setRole(sql)({ roomId: team.roomId, targetUserId: mem1.id, actorUserId: boss.id, role: 'member' });
  check('admin rebaixa de volta', demote.ok === true && demote.role === 'member');
  check('isAdmin volta a negar', db.isAdmin(sql, team.roomId, mem1.id) === false);

  const byMember = db.setRole(sql)({ roomId: team.roomId, targetUserId: mem2.id, actorUserId: mem2.id, role: 'admin' });
  check('membro comum nao pode promover', byMember.ok === false && byMember.error === 'forbidden', JSON.stringify(byMember));

  db.setRole(sql)({ roomId: team.roomId, targetUserId: mem1.id, actorUserId: boss.id, role: 'admin' });
  const selfDemote = db.setRole(sql)({ roomId: team.roomId, targetUserId: mem1.id, actorUserId: mem1.id, role: 'member' });
  check('ninguem rebaixa a si mesmo', selfDemote.ok === false && selfDemote.error === 'self', JSON.stringify(selfDemote));

  const touchCreator = db.setRole(sql)({ roomId: team.roomId, targetUserId: boss.id, actorUserId: mem1.id, role: 'member' });
  check('o criador nunca perde o posto', touchCreator.ok === false && touchCreator.error === 'creator', JSON.stringify(touchCreator));
  check('criador continua admin', db.getMembership(sql, team.roomId, boss.id).role === 'admin');

  const badRole = db.setRole(sql)({ roomId: team.roomId, targetUserId: mem2.id, actorUserId: boss.id, role: 'dono' });
  check('papel invalido e recusado', badRole.ok === false && /invalido/.test(badRole.error || ''), JSON.stringify(badRole));
  const outsider = db.setRole(sql)({ roomId: team.roomId, targetUserId: 999999, actorUserId: boss.id, role: 'admin' });
  check('promover quem nao esta na sala e recusado', outsider.ok === false);

  console.log('\n[15] remover membro e sair');
  const kick = db.removeMember(sql)({ roomId: team.roomId, targetUserId: mem2.id, actorUserId: mem1.id });
  check('admin remove um membro', kick.ok === true && kick.name === 'Dois', JSON.stringify(kick));
  check('removido sai da lista', db.listMembers(sql, team.roomId).every((m) => m.id !== mem2.id));
  check('contador de membros caiu', db.countMembers(sql, team.roomId) === 2, String(db.countMembers(sql, team.roomId)));

  const kickByMember = db.removeMember(sql)({ roomId: team.roomId, targetUserId: mem1.id, actorUserId: mem2.id });
  check('quem nao e admin nao remove os outros', kickByMember.ok === false && kickByMember.error === 'forbidden');

  const leave = db.removeMember(sql)({ roomId: team.roomId, targetUserId: mem1.id, actorUserId: mem1.id });
  check('a pessoa pode sair de si mesma', leave.ok === true && leave.self === true);

  const kickCreator = db.removeMember(sql)({ roomId: team.roomId, targetUserId: boss.id, actorUserId: boss.id });
  check('o criador nao pode ser removido nem sair', kickCreator.ok === false && kickCreator.error === 'creator', JSON.stringify(kickCreator));
  check('criador continua na sala', Boolean(db.getMembership(sql, team.roomId, boss.id)));

  console.log('\n[16] reacoes');
  const chat = mkRoom('chat1', { user: boss });
  const msgA = db.appendMessage(sql, { roomId: chat.roomId, author: 'Chefe', authorId: boss.id, text: 'bora?' });
  const msgB = db.appendMessage(sql, { roomId: chat.roomId, author: 'Chefe', authorId: boss.id, text: 'as 8h' });
  db.joinRoom(sql)({ roomId: chat.roomId, userId: mem1.id });

  const rx1 = db.toggleReaction(sql)({ roomId: chat.roomId, messageId: msgA.message.id.replace('m', ''), userId: boss.id, emoji: '👍' });
  check('reacao adicionada', rx1.ok === true && rx1.added === true, JSON.stringify(rx1).slice(0, 120));
  check('reacao aparece na lista da mensagem', rx1.reactions.length === 1 && rx1.reactions[0].emoji === '👍');
  db.joinRoom(sql)({ roomId: chat.roomId, userId: mem2.id });
  db.toggleReaction(sql)({ roomId: chat.roomId, messageId: msgA.message.id.replace('m', ''), userId: mem1.id, emoji: '👍' });
  db.toggleReaction(sql)({ roomId: chat.roomId, messageId: msgA.message.id.replace('m', ''), userId: mem2.id, emoji: '👍' });
  check('varias pessoas podem usar o mesmo emoji',
    db.listReactionsFor(sql, chat.roomId, msgA.message.id.replace('m', '')).filter((r) => r.emoji === '👍').length === 3,
    JSON.stringify(db.listReactionsFor(sql, chat.roomId, msgA.message.id.replace('m', ''))));
  const trocada = db.toggleReaction(sql)({ roomId: chat.roomId, messageId: msgA.message.id.replace('m', ''), userId: mem1.id, emoji: '🎉' });
  check('reagir com outro emoji TROCA a reacao', trocada.added === true && trocada.changed === true && trocada.emoji === '🎉', JSON.stringify(trocada).slice(0, 120));
  check('uma pessoa tem so UMA reacao por mensagem (a ultima vale)',
    db.listReactionsFor(sql, chat.roomId, msgA.message.id.replace('m', '')).filter((r) => r.userId === mem1.id).length === 1);

  const unreact = db.toggleReaction(sql)({ roomId: chat.roomId, messageId: msgA.message.id.replace('m', ''), userId: boss.id, emoji: '👍' });
  check('reagir com o mesmo emoji desfaz a reacao',
    unreact.added === false && unreact.reactions.every((r) => r.userId !== boss.id), JSON.stringify(unreact.reactions));

  const grouped = db.listReactions(sql, chat.roomId);
  check('listReactions agrupa por mensagem', Object.keys(grouped).includes(msgA.message.id), Object.keys(grouped).join(','));
  check('mensagem sem reacao nao aparece', !Object.keys(grouped).includes(msgB.message.id));

  const outsiderReact = db.toggleReaction(sql)({ roomId: chat.roomId, messageId: msgA.message.id.replace('m', ''), userId: 999999, emoji: '👍' });
  check('quem nao esta na sala nao reage', outsiderReact.ok === false && outsiderReact.error === 'forbidden');
  const ghostMsg = db.toggleReaction(sql)({ roomId: chat.roomId, messageId: 999999, userId: boss.id, emoji: '👍' });
  check('reagir a mensagem inexistente e recusado', ghostMsg.ok === false);

  console.log('\n[17] apagar mensagem');
  const victim = db.appendMessage(sql, { roomId: chat.roomId, author: 'Um', authorId: mem1.id, text: 'segredo' });
  const asOther = db.deleteMessage(sql)({ roomId: chat.roomId, messageId: victim.message.id.replace('m', ''), actorUserId: boss.id });
  check('quem nao e autor nem admin nao apaga... (Chefe e o criador)', asOther.ok === true && asOther.byAdmin === true);
  const afterDelete = db.listMessages(sql, chat.roomId).find((m) => m.id === victim.message.id);
  check('mensagem apagada continua na lista (seq preservada)', Boolean(afterDelete));
  check('mensagem apagada vem sem texto', afterDelete.text === '');
  check('mensagem apagada vem marcada', afterDelete.deleted === true);

  const twiceDel = db.deleteMessage(sql)({ roomId: chat.roomId, messageId: victim.message.id.replace('m', ''), actorUserId: boss.id });
  check('apagar duas vezes e recusado', twiceDel.ok === false);
  const sysMsg = db.listMessages(sql, chat.roomId).find((m) => m.type === 'system');
  if (sysMsg) {
    const delSys = db.deleteMessage(sql)({ roomId: chat.roomId, messageId: sysMsg.id.replace('m', ''), actorUserId: boss.id });
    check('aviso do sistema nao pode ser apagado', delSys.ok === false, JSON.stringify(delSys));
  } else {
    db.appendMessage(sql, { roomId: chat.roomId, author: 'sistema', authorId: null, text: 'aviso', kind: 'system' });
    const sys = db.listMessages(sql, chat.roomId).find((m) => m.type === 'system');
    const delSys = db.deleteMessage(sql)({ roomId: chat.roomId, messageId: sys.id.replace('m', ''), actorUserId: boss.id });
    check('aviso do sistema nao pode ser apagado', delSys.ok === false, JSON.stringify(delSys));
  }

  const own = db.appendMessage(sql, { roomId: chat.roomId, author: 'Chefe', authorId: boss.id, text: 'escrevi errado' });
  const selfDel = db.deleteMessage(sql)({ roomId: chat.roomId, messageId: own.message.id.replace('m', ''), actorUserId: boss.id });
  check('o autor apaga a propria mensagem', selfDel.ok === true && selfDel.byAdmin === false);

  const withRx = db.appendMessage(sql, { roomId: chat.roomId, author: 'Chefe', authorId: boss.id, text: 'com reacao' });
  db.toggleReaction(sql)({ roomId: chat.roomId, messageId: withRx.message.id.replace('m', ''), userId: mem1.id, emoji: '🎉' });
  db.deleteMessage(sql)({ roomId: chat.roomId, messageId: withRx.message.id.replace('m', ''), actorUserId: boss.id });
  check('apagar a mensagem leva as reacoes junto',
    db.listReactionsFor(sql, chat.roomId, withRx.message.id.replace('m', '')).length === 0);

  console.log('\n[18] editar informacoes da sala');
  const upd = db.updateRoom(sql)({ roomId: chat.roomId, actorUserId: boss.id, name: 'Novo nome', description: 'Nova descricao', isPrivate: true });
  check('admin edita a sala', upd.ok === true, JSON.stringify(upd));
  const edited = db.roomProfile(sql, 'chat1');
  check('nome atualizado', edited.name === 'Novo nome', edited.name);
  check('descricao atualizada', edited.description === 'Nova descricao');
  check('privacidade atualizada', edited.isPrivate === true);
  const updByMember = db.updateRoom(sql)({ roomId: chat.roomId, actorUserId: mem1.id, name: 'Hacker' });
  check('membro comum nao edita a sala', updByMember.ok === false && updByMember.error === 'forbidden');
  const emptyName = db.updateRoom(sql)({ roomId: chat.roomId, actorUserId: boss.id, name: '   ' });
  check('nome vazio e recusado', emptyName.ok === false);

  console.log('\n[19] apagar a sala inteira');
  const doomedRoom = mkRoom('fim1', { user: boss });
  db.joinRoom(sql)({ roomId: doomedRoom.roomId, userId: mem1.id });
  db.appendMessage(sql, { roomId: doomedRoom.roomId, author: 'Chefe', authorId: boss.id, text: 'tchau' });
  const notCreator = db.deleteRoom(sql)({ roomId: doomedRoom.roomId, actorUserId: mem1.id });
  check('so o criador apaga a sala', notCreator.ok === false && notCreator.error === 'forbidden', JSON.stringify(notCreator));
  check('sala continua existindo', Boolean(db.getRoomByCode(sql, 'fim1')));

  const deleted = db.deleteRoom(sql)({ roomId: doomedRoom.roomId, actorUserId: boss.id });
  check('criador apaga a sala', deleted.ok === true && deleted.code === 'fim1');
  check('sala sumiu', db.getRoomByCode(sql, 'fim1') === undefined);
  check('mensagens foram junto (cascade)', db.listMessages(sql, doomedRoom.roomId).length === 0);
  check('membros foram junto (cascade)', db.countMembers(sql, doomedRoom.roomId) === 0);
  check('codigo continua bloqueado para sempre',
    mkRoom('fim1', { user: mem1.id ? mem1 : mkUser('x') }).ok === false);
  check('profile de sala apagada e null', db.roomProfile(sql, 'fim1') === null);

  console.log('\n[20] migracao de banco antigo');
  const oldFile = path.join(tmpDir, 'old.db');
  const Database = require('better-sqlite3');
  const oldDb = new Database(oldFile);
  oldDb.exec(`
    CREATE TABLE retired_codes (code TEXT PRIMARY KEY, retired_at INTEGER NOT NULL);
    CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', is_private INTEGER NOT NULL DEFAULT 0, avatar_path TEXT,
      created_by INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE memberships (room_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL, PRIMARY KEY (room_id, user_id));
    CREATE TABLE requests (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', decided_by INTEGER, created_at INTEGER NOT NULL, decided_at INTEGER,
      UNIQUE (room_id, user_id));
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, seq INTEGER NOT NULL,
      author_id INTEGER, author TEXT NOT NULL, client_id TEXT, kind TEXT NOT NULL DEFAULT 'chat',
      text TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (room_id, seq));
    INSERT INTO users (name, token, created_at) VALUES ('Velha', 'tok-velho', 1);
    INSERT INTO rooms (code, name, created_by, created_at) VALUES ('velha1', 'Sala velha', 1, 1);
    INSERT INTO retired_codes (code, retired_at) VALUES ('velha1', 1);
    INSERT INTO retired_codes (code, retired_at) VALUES ('livre1', 1);
    INSERT INTO messages (room_id, seq, author, text, created_at) VALUES (1, 1, 'Velha', 'mensagem antiga', 1);
  `);
  oldDb.close();

  const migrated = db.openDb(oldFile);
  const cols = (t) => migrated.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  check('coluna deleted_at adicionada em messages', cols('messages').includes('deleted_at'));
  check('coluna used_by_room adicionada em retired_codes', cols('retired_codes').includes('used_by_room'));
  check('tabela reactions criada', cols('reactions').length === 5);
  check('codigo da sala existente foi marcado como usado',
    migrated.prepare('SELECT used_by_room u FROM retired_codes WHERE code = ?').get('velha1').u === 1);
  check('codigo apenas reservado continua livre',
    migrated.prepare('SELECT used_by_room u FROM retired_codes WHERE code = ?').get('livre1').u === 0);
  check('mensagem antiga continua la', migrated.prepare('SELECT text FROM messages WHERE seq = 1').get().text === 'mensagem antiga');
  check('sala antiga continua la', db.roomProfile(migrated, 'velha1').name === 'Sala velha');
  const reuseOld = db.reserveCode(migrated, 'velha1');
  check('codigo da sala migrada nao pode ser reaproveitado', reuseOld.ok === false && reuseOld.error === 'code_taken', JSON.stringify(reuseOld));
  migrated.close();

  console.log('\n[21] resposta / citacao');
  const qRoom = db.createRoom(sql)({ code: 'quote1', name: 'Citacoes', description: '', isPrivate: false, avatarPath: null, user: boss });
  const quoteOriginal = db.appendMessage(sql, { roomId: qRoom.roomId, author: 'Chefe', authorId: boss.id, text: 'reuniao as 8h' });
  check('mensagem sem resposta vem com reply null', quoteOriginal.message.reply === null, JSON.stringify(quoteOriginal.message.reply));

  const answer = db.appendMessage(sql, { roomId: qRoom.roomId, author: 'Chefe', authorId: boss.id, text: 'pode ser', replyTo: quoteOriginal.message.id });
  check('resposta guarda a citacao', answer.message.reply !== null, JSON.stringify(answer.message.reply));
  check('citacao traz o autor da original', answer.message.reply.author === 'Chefe', answer.message.reply?.author);
  check('citacao traz o texto da original', answer.message.reply.text === 'reuniao as 8h', answer.message.reply?.text);
  check('citacao aponta para o id certo', answer.message.reply.id === quoteOriginal.message.id, answer.message.reply?.id);

  const acceptsBareNumber = db.appendMessage(sql, { roomId: qRoom.roomId, author: 'Chefe', authorId: boss.id, text: 'ok', replyTo: Number(String(quoteOriginal.message.id).replace('m', '')) });
  check('aceita o id numerico tambem', acceptsBareNumber.message.reply?.id === quoteOriginal.message.id);

  const crossRoom = db.appendMessage(sql, { roomId: qRoom.roomId, author: 'Chefe', authorId: boss.id, text: 'hmm', replyTo: 'm999999' });
  check('citar mensagem inexistente vira reply null (nao quebra)', crossRoom.message.reply === null, JSON.stringify(crossRoom.message.reply));

  // Citar mensagem de OUTRA sala: o servidor tem que ignorar, senao vaza texto
  // entre salas. A FK de reply_to e a rede de seguranca final.
  const otherRoom = db.createRoom(sql)({ code: 'quote2', name: 'Outra', description: '', isPrivate: false, avatarPath: null, user: boss });
  const estrangeira = db.appendMessage(sql, { roomId: otherRoom.roomId, author: 'Chefe', authorId: boss.id, text: 'texto de outra sala' });
  const crossRoomReal = db.appendMessage(sql, { roomId: qRoom.roomId, author: 'Chefe', authorId: boss.id, text: 'hmm', replyTo: estrangeira.message.id });
  check('citar mensagem de outra sala e ignorado', crossRoomReal.message.reply === null, JSON.stringify(crossRoomReal.message.reply));

  const longOriginal = db.appendMessage(sql, { roomId: qRoom.roomId, author: 'Chefe', authorId: boss.id, text: 'x'.repeat(500) });
  const quotingLong = db.appendMessage(sql, { roomId: qRoom.roomId, author: 'Chefe', authorId: boss.id, text: 'li', replyTo: longOriginal.message.id });
  check('trecho citado e truncado para 160 chars', quotingLong.message.reply.text.length === 160, String(quotingLong.message.reply.text.length));
  check('o texto completo da original continua inteiro',
    db.listMessages(sql, qRoom.roomId).find((m) => m.id === longOriginal.message.id).text.length === 500);

  db.deleteMessage(sql)({ roomId: qRoom.roomId, messageId: Number(String(quoteOriginal.message.id).replace('m', '')), actorUserId: boss.id });
  const quoteAfterDelete = db.listMessages(sql, qRoom.roomId).find((m) => m.id === answer.message.id);
  check('resposta sobrevive quando a original e apagada', Boolean(quoteAfterDelete));
  check('citacao avisa que a original foi apagada', quoteAfterDelete.reply.deleted === true, JSON.stringify(quoteAfterDelete.reply));
  check('citacao de apagada vem sem texto', quoteAfterDelete.reply.text === '');

  console.log('\n[22] assinaturas de push');
  const pushUser = mkUser('Push');
  const pushSub1 = { endpoint: 'https://push.example.com/aaa', keys: { p256dh: 'p256dh-1', auth: 'auth-1' } };
  db.addPushSubscription(sql, { endpoint: pushSub1.endpoint, userId: pushUser.id, keys: pushSub1.keys, userAgent: 'Teste/1.0' });
  check('assinatura registrada', db.listPushSubscriptions(sql, pushUser.id).length === 1);
  check('assinatura guarda as chaves', db.listPushSubscriptions(sql, pushUser.id)[0].p256dh === 'p256dh-1');
  check('assinatura guarda o user agent', db.listPushSubscriptions(sql, pushUser.id)[0].user_agent === 'Teste/1.0');

  db.addPushSubscription(sql, { endpoint: pushSub1.endpoint, userId: pushUser.id, keys: { p256dh: 'p256dh-novo', auth: 'auth-novo' } });
  check('re-registrar o mesmo endpoint atualiza em vez de duplicar', db.listPushSubscriptions(sql, pushUser.id).length === 1);
  check('chaves foram atualizadas', db.listPushSubscriptions(sql, pushUser.id)[0].p256dh === 'p256dh-novo');

  db.addPushSubscription(sql, { endpoint: 'https://push.example.com/bbb', userId: pushUser.id, keys: { p256dh: 'p2', auth: 'a2' } });
  check('a mesma pessoa pode ter varios dispositivos', db.listPushSubscriptions(sql, pushUser.id).length === 2);

  const otherPush = mkUser('OutroPush');
  check('assinaturas nao vazam entre pessoas', db.listPushSubscriptions(sql, otherPush.id).length === 0);

  db.prunePushSubscription(sql, 'https://push.example.com/aaa');
  check('endpoint expirado e removido', db.listPushSubscriptions(sql, pushUser.id).length === 1);
  db.removePushSubscription(sql, 'https://push.example.com/bbb');
  check('desativar remove a assinatura', db.listPushSubscriptions(sql, pushUser.id).length === 0);

  const pushRoomOwner = mkUser('DonoPush');
  const pushRoom = db.createRoom(sql)({ code: 'push1', name: 'P', description: '', isPrivate: false, avatarPath: null, user: pushRoomOwner });
  db.addPushSubscription(sql, { endpoint: 'https://push.example.com/ccc', userId: pushRoomOwner.id, keys: { p256dh: 'p', auth: 'a' } });
  db.deleteRoom(sql)({ roomId: pushRoom.roomId, actorUserId: pushRoomOwner.id });
  check('apagar a sala nao apaga a assinatura da pessoa', db.listPushSubscriptions(sql, pushRoomOwner.id).length === 1);


  console.log('\n[23] visto por');
  const vOwner = mkUser('Vera');
  const vRoom = db.createRoom(sql)({ code: 'visto1', name: 'Visto', description: '', isPrivate: false, avatarPath: null, user: vOwner });
  const vBia = mkUser('BiaV');
  const vCai = mkUser('Caio');
  db.joinRoom(sql)({ roomId: vRoom.roomId, userId: vBia.id });
  db.joinRoom(sql)({ roomId: vRoom.roomId, userId: vCai.id });

  const v1 = db.appendMessage(sql, { roomId: vRoom.roomId, author: 'Vera', authorId: vOwner.id, text: 'uma' });
  const v2 = db.appendMessage(sql, { roomId: vRoom.roomId, author: 'Vera', authorId: vOwner.id, text: 'duas' });
  const v3 = db.appendMessage(sql, { roomId: vRoom.roomId, author: 'Vera', authorId: vOwner.id, text: 'tres' });

  check('ninguem leu ainda', Object.keys(db.listReads(sql, vRoom.roomId)).length === 0);

  const mark1 = db.markRead(sql)({ roomId: vRoom.roomId, userId: vBia.id, upToSeq: v2.message.seq });
  check('marcar como lido retorna ok', mark1.ok === true, JSON.stringify(mark1));
  check('marcou exatamente as duas primeiras', mark1.newlyRead === 2, String(mark1.newlyRead));
  const reads1 = db.listReads(sql, vRoom.roomId);
  check('a terceira nao foi marcada', reads1[v3.message.id] === undefined, JSON.stringify(reads1));
  check('as duas primeiras tem a leitora', reads1[v1.message.id]?.[0] === 'BiaV' && reads1[v2.message.id]?.[0] === 'BiaV');

  const markAgain = db.markRead(sql)({ roomId: vRoom.roomId, userId: vBia.id, upToSeq: v2.message.seq });
  check('marcar de novo nao duplica', markAgain.newlyRead === 0, String(markAgain.newlyRead));

  const markAll = db.markRead(sql)({ roomId: vRoom.roomId, userId: vCai.id, upToSeq: v3.message.seq });
  check('segunda pessoa marca tudo', markAll.newlyRead === 3, String(markAll.newlyRead));
  check('agora as tres tem dois leitores',
    db.listReadsFor(sql, vRoom.roomId, Number(String(v1.message.id).replace('m', ''))).length === 2);

  const readOutsider = db.markRead(sql)({ roomId: vRoom.roomId, userId: 999999, upToSeq: v3.message.seq });
  check('quem nao esta na sala nao marca leitura', readOutsider.ok === false && readOutsider.error === 'forbidden', JSON.stringify(readOutsider));
  const badSeq = db.markRead(sql)({ roomId: vRoom.roomId, userId: vBia.id, upToSeq: 0 });
  check('seq invalida e recusada', badSeq.ok === false);

  // A Bia tinha lido so ate a 2a; o Caio le tudo primeiro para que, no teste
  // abaixo, o unico candidato novo seja a mensagem da propria Bia.
  db.markRead(sql)({ roomId: vRoom.roomId, userId: vCai.id, upToSeq: v3.message.seq });
  db.markRead(sql)({ roomId: vRoom.roomId, userId: vBia.id, upToSeq: v3.message.seq });

  const ownMsg = db.appendMessage(sql, { roomId: vRoom.roomId, author: 'BiaV', authorId: vBia.id, text: 'minha' });
  const markOwn = db.markRead(sql)({ roomId: vRoom.roomId, userId: vBia.id, upToSeq: ownMsg.message.seq });
  check('a pessoa nao marca a propria mensagem como lida', markOwn.newlyRead === 0, String(markOwn.newlyRead));
  check('a mensagem dela nao aparece nas leituras',
    db.listReadsFor(sql, vRoom.roomId, Number(String(ownMsg.message.id).replace('m', ''))).length === 0);

  db.deleteRoom(sql)({ roomId: vRoom.roomId, actorUserId: vOwner.id });
  check('leituras vao junto quando a sala e apagada', db.listReads(sql, vRoom.roomId) && Object.keys(db.listReads(sql, vRoom.roomId)).length === 0);

  console.log('\n[24] anexo na mensagem');
  const aOwner = mkUser('Anexa');
  const aRoom = db.createRoom(sql)({ code: 'anex1', name: 'Anexos', description: '', isPrivate: false, avatarPath: null, user: aOwner });
  const img = { kind: 'image', url: '/uploads/foto.jpg', name: 'foto.jpg', mime: 'image/jpeg', bytes: 2048, width: 800, height: 600 };
  const withImg = db.appendMessage(sql, { roomId: aRoom.roomId, author: 'Anexa', authorId: aOwner.id, text: 'olha', attachment: img });
  check('anexo de imagem volta no wire', withImg.message.attachment?.kind === 'image', JSON.stringify(withImg.message.attachment));
  check('anexo guarda url, nome e dimensoes',
    withImg.message.attachment.url === '/uploads/foto.jpg' && withImg.message.attachment.width === 800);
  check('mensagem sem anexo continua null', db.appendMessage(sql, { roomId: aRoom.roomId, author: 'Anexa', authorId: aOwner.id, text: 'só texto' }).message.attachment === null);

  const file = { kind: 'file', url: '/uploads/doc.pdf', name: 'contrato.pdf', mime: 'application/pdf', bytes: 999999 };
  const withFile = db.appendMessage(sql, { roomId: aRoom.roomId, author: 'Anexa', authorId: aOwner.id, text: '', attachment: file });
  check('mensagem pode ser SO anexo, sem texto', withFile.message.text === '' && withFile.message.attachment.kind === 'file');
  check('anexo de arquivo guarda o nome', withFile.message.attachment.name === 'contrato.pdf');

  const persisted = db.listMessages(sql, aRoom.roomId).find((m) => m.id === withImg.message.id);
  check('anexo persiste e volta do historico', persisted.attachment?.url === '/uploads/foto.jpg', JSON.stringify(persisted.attachment));

  const imgId = Number(String(withImg.message.id).replace('m', ''));
  db.deleteMessage(sql)({ roomId: aRoom.roomId, messageId: imgId, actorUserId: aOwner.id });
  const deletedImg = db.listMessages(sql, aRoom.roomId).find((m) => m.id === withImg.message.id);
  check('mensagem apagada nao entrega mais o anexo', deletedImg.attachment === null, JSON.stringify(deletedImg.attachment));

  sql.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${'='.repeat(46)}`);
  console.log(`${passed} passaram, ${failed} falharam`);
  if (failed > 0) {
    console.log(`falhas: ${failures.join(' | ')}`);
    process.exit(1);
  }
  console.log('TUDO OK');
  process.exit(0);
}

main();
