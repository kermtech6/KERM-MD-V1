/**
 * XHRIS HOST Connector v2.1
 *
 * Nouveautés v2.1 :
 *  - .id              → affiche votre ID XHRIS (à donner pour recevoir des coins)
 *  - .transfert <id> <montant> → demande confirmation (1=oui / 2=non) avec
 *                        nom + email du destinataire avant transfert
 *  - .hostlink (.host-link, .lien) → renvoie le lien du site
 *  - Aliases : .transfer, .id, .my-id, .monid
 *
 * Authentification par JID — chaque utilisateur WhatsApp a sa propre session.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const API_BASE  = process.env.XHRIS_API_URL || 'https://api.xhrishost.site/api';
const SITE_URL  = (process.env.XHRIS_SITE_URL || 'https://xhrishost.site').replace(/\/$/, '');
const DEFAULT_OWNER_NUMBER = '237694600007';

// ── Persistance des sessions sur disque ──────────────────────────────────────
const SESSIONS_FILE = path.join(process.cwd(), 'data', 'xhris-sessions.json');

function loadSessionsFromDisk() {
  try {
    const dir = path.dirname(SESSIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      const map = new Map();
      for (const [jid, s] of Object.entries(data)) {
        map.set(jid, { ...s, connectedAt: new Date(s.connectedAt) });
      }
      console.log(`[XHRIS HOST] ${map.size} session(s) restaurée(s) depuis le disque`);
      return map;
    }
  } catch (e) {
    console.error('[XHRIS HOST] Erreur load sessions:', e.message);
  }
  return new Map();
}

function persistSessions() {
  try {
    const obj = {};
    for (const [jid, s] of sessions.entries()) obj[jid] = s;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[XHRIS HOST] Erreur save sessions:', e.message);
  }
}

// Per-JID session store: { [jid]: { apiKey, user, connectedAt } }
const sessions = loadSessionsFromDisk();

// Pending verification: { [jid]: requestId }
const awaitingCode = new Map();

// Pending transfer confirmation: { [jid]: { recipient, amount, ts } }
const awaitingTransferConfirm = new Map();
const CONFIRM_TIMEOUT_MS = 90 * 1000; // 90s pour répondre 1 ou 2

function getSession(jid) {
  return sessions.get(jid) || null;
}

function senderJid(sock, msg) {
  const jid = msg.key.remoteJid || '';
  if (!jid.endsWith('@g.us')) return msg.key.fromMe ? (sock.user?.id || jid) : jid;
  return msg.key.participant || jid;
}

function isPrivileged(sock, msg) {
  if (msg.key.fromMe) return true;
  const jid = senderJid(sock, msg);
  const num = (jid || '').split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
  const owner = (process.env.OWNER_NUMBER || process.env.OWNER || DEFAULT_OWNER_NUMBER).replace(/[^0-9]/g, '');
  if (num && owner && num === owner) return true;
  if (num === DEFAULT_OWNER_NUMBER) return true;
  const botNum = (sock.user?.id || '').split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
  if (num && botNum && num === botNum) return true;
  const sudos = (process.env.SUDO || '').split(',').map(s => s.replace(/[^0-9]/g, '')).filter(Boolean);
  return sudos.includes(num);
}

async function apiCall(endpoint, method = 'GET', body = null, apiKey = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(API_BASE + endpoint, opts);
    return res.json();
  } catch (e) {
    return { success: false, message: 'Erreur réseau: ' + e.message };
  }
}

async function onBotStart(sock, ownerJid) {
  const envKey = process.env.XHRIS_API_KEY || null;
  if (envKey && ownerJid) {
    const res = await apiCall('/users/me', 'GET', null, envKey);
    if (res.success) {
      sessions.set(ownerJid, { apiKey: envKey, user: res.data, connectedAt: new Date() });
      persistSessions();
      const deployType = process.env.XHRIS_DEPLOY_TYPE || 'upload';
      await sock.sendMessage(ownerJid, {
        text:
          '✅ *XHRIS HOSTING Connecté !*\n\n' +
          '👤 Utilisateur: ' + res.data.name + '\n' +
          '🤖 Bot: ' + (process.env.BOT_NAME || 'XHRIS-MD') + '\n' +
          '📦 Mode: ' + (deployType === '1click' ? '🚀 1-Click Deploy' : '📁 Upload') + '\n\n' +
          'Tapez *.host* pour le menu.',
      });
    }
  } else {
    console.log('[XHRIS HOST] Aucune clé env — les utilisateurs doivent s\'authentifier via .xhrishost');
  }
}

async function handleCommand(sock, msg) {
  const rawText =
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    '';
  const text = rawText;
  const trimmed = text.trim();
  const jid = msg.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');
  if (isGroup && !isPrivileged(sock, msg)) return false;
  const session = getSession(jid);

  // ── Confirmation transfert en attente (1 ou 2) ─────────────────────────
  if (awaitingTransferConfirm.has(jid)) {
    const pending = awaitingTransferConfirm.get(jid);

    // Timeout dépassé
    if (Date.now() - pending.ts > CONFIRM_TIMEOUT_MS) {
      awaitingTransferConfirm.delete(jid);
      await sock.sendMessage(jid, {
        text: '⏱️ Délai dépassé. Le transfert a été annulé.\nRelancez avec *.transfert <id> <montant>*',
      });
      return true;
    }

    if (trimmed === '1' || trimmed.toLowerCase() === 'oui' || trimmed.toLowerCase() === 'yes') {
      awaitingTransferConfirm.delete(jid);
      if (!session) {
        await sock.sendMessage(jid, { text: '🔒 Session expirée. Tapez *.xhrishost*.' });
        return true;
      }
      await sock.sendMessage(jid, { text: '🔄 Transfert en cours...' });
      const res = await apiCall('/coins/transfer', 'POST', {
        recipientId: pending.recipient.id,
        amount: pending.amount,
      }, session.apiKey);

      if (res.success) {
        await sock.sendMessage(jid, {
          text:
            '✅ *Transfert effectué !*\n\n' +
            '💰 Montant: *' + pending.amount + ' coins*\n' +
            '👤 Destinataire: *' + pending.recipient.name + '*\n' +
            '📧 ' + pending.recipient.email + '\n\n' +
            'Frais: 1 coin\n' +
            'Tapez *.coins* pour voir votre solde.',
        });
      } else {
        await sock.sendMessage(jid, {
          text: '❌ ' + (res.message || 'Erreur de transfert'),
        });
      }
      return true;
    }

    if (trimmed === '2' || trimmed.toLowerCase() === 'non' || trimmed.toLowerCase() === 'no') {
      awaitingTransferConfirm.delete(jid);
      await sock.sendMessage(jid, { text: '❌ Transfert annulé.' });
      return true;
    }

    // Réponse invalide → on rappelle les options
    await sock.sendMessage(jid, {
      text: '❓ Répondez *1* pour confirmer ou *2* pour annuler.\n\n' +
        '(Demande expirera dans ' +
        Math.max(0, Math.ceil((CONFIRM_TIMEOUT_MS - (Date.now() - pending.ts)) / 1000)) +
        's)',
    });
    return true;
  }

  // ── Vérification du code (état en attente) ──────────────────────────────────
  if (awaitingCode.has(jid) && /^\d{6}$/.test(trimmed)) {
    const requestId = awaitingCode.get(jid);
    const code = trimmed;
    awaitingCode.delete(jid);

    await sock.sendMessage(jid, { text: '🔄 Vérification en cours...' });
    const res = await apiCall('/auth/whatsapp/verify', 'POST', { requestId, code, whatsappJid: jid });

    if (res.success) {
      const { apiKey, user } = res.data;
      sessions.set(jid, { apiKey, user, connectedAt: new Date() });
      persistSessions();
      await sock.sendMessage(jid, {
        text:
          '✅ *Connexion réussie !*\n\n' +
          '👤 ' + user.name + '\n' +
          '💰 ' + user.coins + ' coins\n' +
          '📦 Plan: ' + user.plan + '\n\n' +
          'Tapez *.host* pour le menu complet.',
      });
    } else {
      await sock.sendMessage(jid, {
        text: '❌ ' + (res.message || 'Code incorrect ou expiré') + '\n\nTapez *.xhrishost* pour recommencer.',
      });
    }
    return true;
  }

  // ── .xhrishost — Démarrer l'authentification ─────────────────────────────
  if (trimmed === '.xhrishost') {
    if (session) {
      await sock.sendMessage(jid, {
        text:
          '✅ Déjà connecté en tant que *' + session.user.name + '*\n' +
          'Tapez *.host* pour le menu ou *.deconnexion* pour vous déconnecter.',
      });
      return true;
    }

    await sock.sendMessage(jid, { text: '🔄 Génération du code de vérification...' });
    const res = await apiCall('/auth/whatsapp/request', 'POST', { whatsappJid: jid });

    if (!res.success) {
      await sock.sendMessage(jid, { text: '❌ ' + (res.message || 'Erreur') });
      return true;
    }

    awaitingCode.set(jid, res.data.requestId);

    var capturedRequestId = res.data.requestId;
    setTimeout(function() {
      if (awaitingCode.get(jid) === capturedRequestId) {
        awaitingCode.delete(jid);
      }
    }, 3 * 60 * 1000);

    await sock.sendMessage(jid, {
      text:
        '🔐 *Authentification XHRIS HOST*\n\n' +
        '1️⃣ Ouvrez ce lien dans votre navigateur:\n' +
        '🔗 ' + res.data.verifyLink + '\n\n' +
        '2️⃣ Connectez-vous à votre compte\n' +
        '3️⃣ Copiez le code à 6 chiffres affiché\n' +
        '4️⃣ Envoyez-le ici dans ce chat\n\n' +
        '⏱️ Le code expire dans 3 minutes.',
    });
    return true;
  }

  // ── .hostlink / .host-link / .lien — Lien du site (PUBLIC, pas d'auth) ───
  if (trimmed === '.hostlink' || trimmed === '.host-link' || trimmed === '.lien' || trimmed === '.site') {
    await sock.sendMessage(jid, {
      text:
        '🌐 *XHRIS HOST*\n\n' +
        '🔗 ' + SITE_URL + '\n\n' +
        '🤖 Hébergement de bots WhatsApp, Telegram, Discord.\n' +
        '🚀 Déploiement en 1-clic depuis le Marketplace.\n' +
        '💰 Tarification flexible avec Coins.\n\n' +
        'Créez votre compte et déployez votre premier bot en moins de 2 minutes.',
    });
    return true;
  }

  // ── .deconnexion ─────────────────────────────────────────────────────────
  if (trimmed === '.deconnexion') {
    sessions.delete(jid);
    persistSessions();
    awaitingTransferConfirm.delete(jid);
    await sock.sendMessage(jid, { text: '👋 Déconnecté. Tapez *.xhrishost* pour vous reconnecter.' });
    return true;
  }

  // ── .host — Menu (auth requise) ──────────────────────────────────────────
  if (trimmed === '.host') {
    if (!session) {
      await sock.sendMessage(jid, { text: '🔒 Non connecté. Tapez *.xhrishost* pour vous authentifier.' });
      return true;
    }
    await sock.sendMessage(jid, {
      text:
        '╔═══════════════════════╗\n' +
        '║  🌐 *XHRIS HOST*       ║\n' +
        '╠═══════════════════════╣\n' +
        '║ .id          — Mon ID  ║\n' +
        '║ .profil      — Profil   ║\n' +
        '║ .coins       — Solde    ║\n' +
        '║ .serveurs    — Servers  ║\n' +
        '║ .bots        — Mes bots ║\n' +
        '║ .market      — Market   ║\n' +
        '║ .historique  — Txns     ║\n' +
        '║ .transfert   — Envoyer  ║\n' +
        '║ .acheter     — Acheter  ║\n' +
        '║ .hostlink    — Site web ║\n' +
        '║ .deconnexion — Quitter  ║\n' +
        '╚═══════════════════════╝\n\n' +
        '👤 Connecté: ' + session.user.name,
    });
    return true;
  }

  // Commands requiring authentication
  if (!session) return false;
  const key = session.apiKey;

  // ── .id / .my-id / .monid — Affiche votre ID XHRIS ─────────────────────
  if (trimmed === '.id' || trimmed === '.my-id' || trimmed === '.monid' || trimmed === '.myid') {
    try {
      const res = await apiCall('/users/me', 'GET', null, key);
      const u = res.success ? res.data : session.user;
      // Mettre à jour la session locale avec les données fraîches
      if (res.success) {
        session.user = u;
        sessions.set(jid, session);
        persistSessions();
      }
      await sock.sendMessage(jid, {
        text:
          '🆔 *Votre ID XHRIS Host*\n\n' +
          '```' + u.id + '```\n\n' +
          '📋 Copiez cet ID (appui long → copier).\n' +
          '_Cet ID sert à recevoir des coins via :_\n' +
          '*.transfert ' + u.id + ' <montant>*\n\n' +
          '👤 ' + u.name + '\n' +
          '📧 ' + (u.email || '—') + '\n' +
          '💰 ' + (u.coins || 0) + ' coins',
      });
    } catch (e) {
      await sock.sendMessage(jid, { text: '❌ Erreur: ' + e.message });
    }
    return true;
  }

  if (trimmed === '.profil') {
    const res = await apiCall('/users/me', 'GET', null, key);
    if (res.success) {
      const u = res.data;
      await sock.sendMessage(jid, {
        text:
          '👤 *Profil XHRIS HOST*\n\n' +
          '📛 Nom: ' + u.name + '\n' +
          '📧 Email: ' + u.email + '\n' +
          '🆔 ID: ```' + u.id + '```\n' +
          '💰 Coins: ' + u.coins + '\n' +
          '⭐ Niveau: ' + (u.level || 1) + ' (' + (u.xp || 0) + ' XP)\n' +
          '📦 Plan: ' + u.plan,
      });
    } else {
      await sock.sendMessage(jid, { text: '❌ ' + (res.message || 'Erreur') });
    }
    return true;
  }

  if (trimmed === '.coins') {
    const res = await apiCall('/coins/balance', 'GET', null, key);
    if (res.success) {
      await sock.sendMessage(jid, {
        text:
          '💰 *Solde:* ' + (res.data.coins || 0) + ' coins\n\n' +
          '📥 Pour recevoir des coins, donnez votre ID :\n' +
          '*.id*\n' +
          '📤 Pour en envoyer :\n' +
          '*.transfert <id> <montant>*',
      });
    } else {
      await sock.sendMessage(jid, { text: '❌ ' + (res.message || 'Erreur') });
    }
    return true;
  }

  if (trimmed === '.serveurs') {
    const res = await apiCall('/servers', 'GET', null, key);
    if (res.success) {
      const servers = res.data?.servers || res.data?.data || res.data || [];
      if (!Array.isArray(servers) || !servers.length) {
        await sock.sendMessage(jid, { text: '📡 Aucun serveur.' });
        return true;
      }
      let txt = '📡 *Mes Serveurs*\n\n';
      servers.forEach((s, i) => { txt += (i + 1) + '. *' + s.name + '*\n   ' + s.status + ' | ' + s.plan + '\n\n'; });
      txt += 'Cmds: .start-srv <id> | .stop-srv <id>';
      await sock.sendMessage(jid, { text: txt });
    } else {
      await sock.sendMessage(jid, { text: '❌ ' + (res.message || 'Erreur') });
    }
    return true;
  }

  if (trimmed === '.bots') {
    const res = await apiCall('/bots', 'GET', null, key);
    if (res.success) {
      const bots = res.data?.bots || res.data?.data || res.data || [];
      if (!Array.isArray(bots) || !bots.length) {
        await sock.sendMessage(jid, { text: '🤖 Aucun bot déployé.' });
        return true;
      }
      let txt = '🤖 *Mes Bots*\n\n';
      bots.forEach((b, i) => { txt += (i + 1) + '. *' + b.name + '* [' + b.status + ']\n   ' + b.platform + '\n\n'; });
      txt += 'Cmds: .start-bot <id> | .stop-bot <id> | .restart-bot <id>';
      await sock.sendMessage(jid, { text: txt });
    } else {
      await sock.sendMessage(jid, { text: '❌ ' + (res.message || 'Erreur') });
    }
    return true;
  }

  if (trimmed === '.market') {
    const res = await apiCall('/marketplace/bots', 'GET', null, key);
    if (res.success) {
      const bots = res.data?.data || res.data?.bots || res.data || [];
      let txt = '🏪 *Marketplace XHRIS HOST*\n\n';
      bots.slice(0, 8).forEach((b, i) => {
        txt += (i + 1) + '. *' + b.name + '* ⭐' + (b.rating || 0) + '\n   ' + (b.description || '').slice(0, 60) + '...\n\n';
      });
      txt += '🔗 Plus sur ' + SITE_URL + '/marketplace';
      await sock.sendMessage(jid, { text: txt });
    } else {
      await sock.sendMessage(jid, { text: '❌ ' + (res.message || 'Erreur') });
    }
    return true;
  }

  if (trimmed === '.historique') {
    const res = await apiCall('/coins/transactions?limit=10', 'GET', null, key);
    if (res.success) {
      const txs = res.data?.transactions || res.data?.data || res.data || [];
      if (!Array.isArray(txs) || !txs.length) {
        await sock.sendMessage(jid, { text: '📜 Aucune transaction.' });
        return true;
      }
      let txt = '📜 *Historique (10 dernières)*\n\n';
      txs.forEach(t => {
        const sign = (t.amount > 0) ? '➕' : '➖';
        txt += sign + ' ' + Math.abs(t.amount) + ' — ' + (t.description || t.type) + '\n';
      });
      await sock.sendMessage(jid, { text: txt });
    } else {
      await sock.sendMessage(jid, { text: '❌ ' + (res.message || 'Erreur') });
    }
    return true;
  }

  // ── .transfert / .transfer <id> <montant> — avec CONFIRMATION ─────────
  if (trimmed.startsWith('.transfert ') || trimmed.startsWith('.transfer ')) {
    const parts = trimmed.split(/\s+/);
    const recipientId = (parts[1] || '').trim();
    const amount = parseInt(parts[2], 10);

    if (!recipientId || !amount || amount <= 0 || Number.isNaN(amount)) {
      await sock.sendMessage(jid, {
        text:
          '❌ *Usage incorrect*\n\n' +
          'Format : *.transfert <id> <montant>*\n\n' +
          'Exemple : *.transfert cm1abc23def 100*\n\n' +
          '💡 Pour avoir votre ID, tapez *.id*',
      });
      return true;
    }

    if (recipientId === session.user.id) {
      await sock.sendMessage(jid, { text: '❌ Vous ne pouvez pas vous envoyer des coins à vous-même.' });
      return true;
    }

    // Récupérer les infos du destinataire pour confirmation
    await sock.sendMessage(jid, { text: '🔍 Recherche du destinataire...' });
    const lookup = await apiCall('/coins/lookup/' + encodeURIComponent(recipientId), 'GET', null, key);

    if (!lookup.success) {
      await sock.sendMessage(jid, {
        text: '❌ ' + (lookup.message || 'Destinataire introuvable. Vérifiez l\'ID.'),
      });
      return true;
    }

    const recipient = lookup.data;
    const fee = 1;
    const total = amount + fee;

    // Stocker la demande en attente
    awaitingTransferConfirm.set(jid, {
      recipient: recipient,
      amount: amount,
      ts: Date.now(),
    });

    // Auto-cleanup après timeout
    setTimeout(() => {
      const p = awaitingTransferConfirm.get(jid);
      if (p && p.recipient.id === recipient.id && p.amount === amount) {
        awaitingTransferConfirm.delete(jid);
      }
    }, CONFIRM_TIMEOUT_MS);

    await sock.sendMessage(jid, {
      text:
        '⚠️ *Confirmation de transfert*\n\n' +
        '👤 Destinataire: *' + recipient.name + '*\n' +
        '📧 Email: ' + (recipient.email || '—') + '\n' +
        '📦 Plan: ' + (recipient.plan || 'FREE') + '\n\n' +
        '💰 Montant: *' + amount + ' coins*\n' +
        '💸 Frais: *' + fee + ' coin*\n' +
        '━━━━━━━━━━━━━━━━━━\n' +
        '🧮 Total débité: *' + total + ' coins*\n\n' +
        '*Répondez :*\n' +
        '*1* — ✅ Confirmer le transfert\n' +
        '*2* — ❌ Annuler\n\n' +
        '⏱️ Vous avez 90 secondes pour répondre.',
    });
    return true;
  }

  if (trimmed === '.acheter') {
    await sock.sendMessage(jid, {
      text:
        '💳 *Acheter des Coins*\n\n' +
        'Rendez-vous sur :\n🔗 ' + SITE_URL + '/dashboard/coins/buy\n\n' +
        '*Packs disponibles :*\n' +
        '• 500 coins — 1.99€\n' +
        '• 1 000 coins — 3.49€ (+100 bonus) ⭐\n' +
        '• 2 500 coins — 7.99€ (+300 bonus)\n' +
        '• 5 000 coins — 14.99€ (+700 bonus)\n' +
        '• 10 000 coins — 27.99€ (+1500 bonus)\n\n' +
        '*Moyens de paiement :*\n' +
        '• 📱 Mobile Money (Fapshi)\n' +
        '• 💳 Carte bancaire (GeniusPay)\n' +
        '• 💸 Virement manuel',
    });
    return true;
  }

  // Bot/server actions
  if (trimmed.startsWith('.start-bot ')) { const id = trimmed.split(/\s+/)[1]; const res = await apiCall('/bots/' + id + '/start', 'POST', null, key); await sock.sendMessage(jid, { text: res.success ? '✅ Bot démarré' : '❌ ' + (res.message || 'Erreur') }); return true; }
  if (trimmed.startsWith('.stop-bot ')) { const id = trimmed.split(/\s+/)[1]; const res = await apiCall('/bots/' + id + '/stop', 'POST', null, key); await sock.sendMessage(jid, { text: res.success ? '✅ Bot arrêté' : '❌ ' + (res.message || 'Erreur') }); return true; }
  if (trimmed.startsWith('.restart-bot ')) { const id = trimmed.split(/\s+/)[1]; const res = await apiCall('/bots/' + id + '/restart', 'POST', null, key); await sock.sendMessage(jid, { text: res.success ? '✅ Bot redémarré' : '❌ ' + (res.message || 'Erreur') }); return true; }
  if (trimmed.startsWith('.start-srv ')) { const id = trimmed.split(/\s+/)[1]; const res = await apiCall('/servers/' + id + '/start', 'POST', null, key); await sock.sendMessage(jid, { text: res.success ? '✅ Serveur démarré' : '❌ ' + (res.message || 'Erreur') }); return true; }
  if (trimmed.startsWith('.stop-srv ')) { const id = trimmed.split(/\s+/)[1]; const res = await apiCall('/servers/' + id + '/stop', 'POST', null, key); await sock.sendMessage(jid, { text: res.success ? '✅ Serveur arrêté' : '❌ ' + (res.message || 'Erreur') }); return true; }
  if (trimmed.startsWith('.delete-srv ')) { const id = trimmed.split(/\s+/)[1]; const res = await apiCall('/servers/' + id, 'DELETE', null, key); await sock.sendMessage(jid, { text: res.success ? '✅ Serveur supprimé' : '❌ ' + (res.message || 'Erreur') }); return true; }

  return false;
}

console.log('[XHRIS HOST] ✅ Connector v2.1 chargé — Auth par JID activée');
console.log('[XHRIS HOST] Tapez .xhrishost dans WhatsApp pour démarrer l\'authentification');

module.exports = { handleCommand, apiCall, onBotStart, getSession };
