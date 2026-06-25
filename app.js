let myId = "";
let idVisible = false;
let signalingBroker = null;
let currentChatPeerId = null;

// Local Memory (Now includes Contacts)
let contacts = JSON.parse(localStorage.getItem('ghost_contacts')) || {};
let activeChats = []; 
let cachedOffers = {};
let sharedSecrets = {};

let localKeyPair = null;
let localPublicKeyJWK = null;

window.addEventListener('DOMContentLoaded', async () => {
    generateUserIdentity();
    await initializeCrypto();
    initializeRelaySystem();
    updateSidebarUI();
    setupMediaListener();
});

function generateUserIdentity() {
    let savedId = localStorage.getItem('ghost_my_id');
    if (!savedId) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let segment = () => Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        savedId = `${segment()}-${segment()}-${segment()}`;
        localStorage.setItem('ghost_my_id', savedId);
    }
    myId = savedId;
}

// Contacts Management
function getAlias(id) {
    return contacts[id] || id;
}

function promptRenameContact() {
    if (!currentChatPeerId) return;
    const currentName = contacts[currentChatPeerId] || "";
    const newName = prompt(`Enter a contact name for ${currentChatPeerId}:`, currentName);
    
    if (newName !== null) {
        if (newName.trim() === "") {
            delete contacts[currentChatPeerId];
        } else {
            contacts[currentChatPeerId] = newName.trim();
        }
        localStorage.setItem('ghost_contacts', JSON.stringify(contacts));
        document.getElementById('current-chat-name').innerText = getAlias(currentChatPeerId);
        updateSidebarUI();
    }
}

async function initializeCrypto() {
    localKeyPair = await window.crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
    localPublicKeyJWK = await window.crypto.subtle.exportKey("jwk", localKeyPair.publicKey);
}

async function deriveAESKey(peerPublicKeyJWK, peerId) {
    const peerKey = await window.crypto.subtle.importKey("jwk", peerPublicKeyJWK, { name: "ECDH", namedCurve: "P-256" }, true, []);
    const sharedSecret = await window.crypto.subtle.deriveKey(
        { name: "ECDH", public: peerKey }, localKeyPair.privateKey,
        { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
    );
    sharedSecrets[peerId] = sharedSecret;
}

function initializeRelaySystem() {
    signalingBroker = mqtt.connect('wss://broker.emqx.io:8084/mqtt');
    signalingBroker.on('connect', () => signalingBroker.subscribe(`ghoststream/chat/${myId}`));

    signalingBroker.on('message', async (topic, payload) => {
        const packet = JSON.parse(payload.toString());
        
        if (packet.type === 'request') {
            cachedOffers[packet.sender] = packet.pubKey;
            updateSidebarUI();
        } else if (packet.type === 'accept') {
            await deriveAESKey(packet.pubKey, packet.sender);
            trackActiveChatSession(packet.sender);
            openActiveChatView(packet.sender, "Secure Tunnel Active");
        } else if (packet.type === 'message') {
            if (!sharedSecrets[packet.sender]) return;
            try {
                const decryptedText = await decryptMessage(packet.cipher, packet.iv, packet.sender);
                // Parse the internal payload
                const payloadData = JSON.parse(decryptedText);
                
                if (currentChatPeerId === packet.sender) {
                    renderBubble(payloadData.content, 'received', payloadData.msgType);
                }
                trackActiveChatSession(packet.sender);
            } catch (err) { console.error("Decryption failed."); }
        }
    });
}

function requestPeerConnection() {
    const peerId = document.getElementById('connect-peer-id').value.trim();
    if (!peerId || peerId === myId) return alert("Invalid Target Node.");

    closeNewChatModal();
    currentChatPeerId = peerId;

    signalingBroker.publish(`ghoststream/chat/${peerId}`, JSON.stringify({ type: 'request', sender: myId, pubKey: localPublicKeyJWK }));
    trackActiveChatSession(peerId);
    openActiveChatView(peerId, "Awaiting handshake...");
}

async function handleAllow() {
    const senderId = currentChatPeerId;
    await deriveAESKey(cachedOffers[senderId], senderId);
    
    signalingBroker.publish(`ghoststream/chat/${senderId}`, JSON.stringify({ type: 'accept', sender: myId, pubKey: localPublicKeyJWK }));

    delete cachedOffers[senderId];
    trackActiveChatSession(senderId);
    openActiveChatView(senderId, "Secure Tunnel Active");
}

function handleDeny() {
    delete cachedOffers[currentChatPeerId];
    currentChatPeerId = null;
    updateSidebarUI();
    switchView('view-blank');
}

// Media Handling via Base64
function setupMediaListener() {
    document.getElementById('media-input').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        // Size Limit: 1MB (To respect public MQTT payload limits)
        if (file.size > 1024 * 1024) {
            alert("File exceeds 1MB secure relay limit. Compress before sending.");
            this.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = async function(event) {
            const base64Data = event.target.result;
            await sendSecureMessage('image', base64Data);
            this.value = ''; // Reset input
        };
        reader.readAsDataURL(file);
    });
}

// Encryption & Decryption
async function encryptMessage(text, peerId) {
    const key = sharedSecrets[peerId];
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encodedText = new TextEncoder().encode(text);
    const cipherBuffer = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, encodedText);
    return { cipher: Array.from(new Uint8Array(cipherBuffer)), iv: Array.from(iv) };
}

async function decryptMessage(cipherArray, ivArray, peerId) {
    const key = sharedSecrets[peerId];
    const decryptedBuffer = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(ivArray) }, key, new Uint8Array(cipherArray));
    return new TextDecoder().decode(decryptedBuffer);
}

// Unified Send Function (Text & Media)
async function sendSecureMessage(type, explicitContent = null) {
    let content = explicitContent;
    const inputField = document.getElementById('chat-input');

    if (type === 'text') {
        content = inputField.value.trim();
        if (!content) return;
    }

    if (!currentChatPeerId || !sharedSecrets[currentChatPeerId]) return alert("Secure tunnel not active.");

    // We package the type and content together inside the encrypted vault
    const internalPayload = JSON.stringify({ msgType: type, content: content });
    const encryptedPayload = await encryptMessage(internalPayload, currentChatPeerId);

    signalingBroker.publish(`ghoststream/chat/${currentChatPeerId}`, JSON.stringify({
        type: 'message', sender: myId, cipher: encryptedPayload.cipher, iv: encryptedPayload.iv
    }));

    renderBubble(content, 'sent', type);
    if (type === 'text') inputField.value = '';
}

// UI Rendering
function toggleIDVisibility() {
    const idSpan = document.getElementById('my-unique-id');
    idVisible = !idVisible;
    if (idVisible) {
        idSpan.innerText = myId;
        idSpan.classList.remove('censored');
        navigator.clipboard.writeText(myId);
        setTimeout(() => { idVisible = false; idSpan.innerText = "***-***-***"; idSpan.classList.add('censored'); }, 3000);
    }
}

function updateSidebarUI() {
    const promptBox = document.getElementById('empty-state-prompt');
    const chatList = document.getElementById('chat-list');
    const fab = document.getElementById('fab-new-chat');
    
    if (activeChats.length === 0 && Object.keys(cachedOffers).length === 0) {
        promptBox.classList.remove('hidden'); chatList.classList.add('hidden'); fab.classList.add('hidden');
    } else {
        promptBox.classList.add('hidden'); chatList.classList.remove('hidden'); fab.classList.remove('hidden');
        renderChatList();
    }
}

function renderChatList() {
    const list = document.getElementById('chat-list');
    list.innerHTML = '';

    Object.keys(cachedOffers).forEach(senderId => {
        const li = document.createElement('li');
        li.className = 'chat-item pending';
        li.innerHTML = `<div class="avatar" style="background: #f59e0b;">?</div><div class="details"><span class="title">${getAlias(senderId)}</span><span class="subtitle">Action Required</span></div>`;
        li.onclick = () => openPendingRequestView(senderId);
        list.appendChild(li);
    });

    activeChats.forEach(id => {
        const li = document.createElement('li');
        li.className = 'chat-item';
        const alias = getAlias(id);
        li.innerHTML = `<div class="avatar">${alias.charAt(0).toUpperCase()}</div><div class="details"><span class="title">${alias}</span><span class="subtitle">Tunnel Ready</span></div>`;
        li.onclick = () => {
            if (currentChatPeerId !== id) {
                currentChatPeerId = id;
                openActiveChatView(id, sharedSecrets[id] ? "Secure Tunnel Active" : "Session Expired");
            }
        };
        list.appendChild(li);
    });
}

function trackActiveChatSession(id) {
    if (!activeChats.includes(id)) { activeChats.push(id); updateSidebarUI(); }
}

function switchView(viewId) {
    document.querySelectorAll('.view-pane').forEach(el => el.classList.remove('active-view'));
    document.getElementById(viewId).classList.add('active-view');
}

function openPendingRequestView(senderId) {
    currentChatPeerId = senderId;
    document.getElementById('pending-peer-id').innerText = getAlias(senderId);
    switchView('view-pending');
}

function openActiveChatView(peerId, status) {
    const alias = getAlias(peerId);
    document.getElementById('current-chat-name').innerText = alias;
    document.getElementById('chat-avatar').innerText = alias.charAt(0).toUpperCase();
    document.getElementById('current-chat-status').innerText = status;
    document.getElementById('messages-window').innerHTML = ''; 
    switchView('view-chat');
}

function renderBubble(content, direction, type) {
    const window = document.getElementById('messages-window');
    const bubble = document.createElement('div');
    bubble.className = `bubble ${direction}`;
    
    if (type === 'text') {
        bubble.innerText = content;
    } else if (type === 'image') {
        bubble.innerHTML = `<img src="${content}" class="media-img" onclick="window.open('${content}')">`;
    }
    
    window.appendChild(bubble);
    window.scrollTop = window.scrollHeight;
}

function openNewChatModal() { document.getElementById('new-chat-modal').classList.remove('hidden'); }
function closeNewChatModal() { document.getElementById('new-chat-modal').classList.add('hidden'); }
